import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {
  IMAGE_PROCESS_DEFAULTS,
  MAX_THUMBNAIL_BYTES,
  MAX_VIEW_BYTES,
  convertImageBytesToPng,
  formatImageCaption,
  orientedDimensions,
  orientedPointFromStored,
  processImageBytes,
  renderThumbnailBytes,
  renderViewBytes,
  sniffImage,
  storedPointFromOriented,
} from '../src/tools/imageFile.js'
import { loadFixtureBytes, makeBmpBytes } from './helpers/imageFixtures.js'

// ---------------------------------------------------------------------------
// Deterministic noise. Random-per-run bytes would make ladder sizes (and thus
// which rung a budget selects) vary between runs; a seeded xorshift keeps every
// size stable while staying incompressible enough to push encoders around.
// ---------------------------------------------------------------------------

function xorshift32(seed: number): () => number {
  let state = seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function noiseImage(
  width: number,
  height: number,
  withTransparentRightHalf = false,
): Promise<Buffer> {
  const random = xorshift32(0x5eed_1234)
  const data = Buffer.alloc(width * height * (withTransparentRightHalf ? 4 : 3))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * (withTransparentRightHalf ? 4 : 3)
      data[offset] = Math.floor(random() * 256)
      data[offset + 1] = Math.floor(random() * 256)
      data[offset + 2] = Math.floor(random() * 256)
      if (withTransparentRightHalf) data[offset + 3] = x >= width / 2 ? 0 : 255
    }
  }
  return sharp(data, {
    raw: { width, height, channels: withTransparentRightHalf ? 4 : 3 },
  })
    .png()
    .toBuffer()
}

/** A smooth 3840x2160 "screenshot": gradients compress well, so it exercises
 *  the default budget without multi-megabyte fixtures. */
function gradientImage(width: number, height: number): Promise<Buffer> {
  const data = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3
      data[offset] = Math.floor((x * 255) / width)
      data[offset + 1] = Math.floor((y * 255) / height)
      data[offset + 2] = 128
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer()
}

async function decodedPixel(
  bytes: Buffer,
  x: number,
  y: number,
): Promise<number[]> {
  const { data, info } = await sharp(bytes)
    .raw()
    .toBuffer({ resolveWithObject: true })
  const offset = (y * info.width + x) * info.channels
  return [...data.subarray(offset, offset + info.channels)]
}

// ---------------------------------------------------------------------------
// Content sniffing
// ---------------------------------------------------------------------------

test('sniffImage recognizes supported formats by content, not extension', async () => {
  assert.deepEqual(sniffImage(await loadFixtureBytes('transparent.png')), {
    format: 'png',
    supported: true,
  })
  assert.deepEqual(sniffImage(await loadFixtureBytes('exif-orientation.jpg')), {
    format: 'jpeg',
    supported: true,
  })
  assert.deepEqual(sniffImage(await loadFixtureBytes('static.webp')), {
    format: 'webp',
    supported: true,
  })
  assert.deepEqual(sniffImage(await loadFixtureBytes('single-frame.gif')), {
    format: 'gif',
    supported: true,
  })
  // The fake-extension fixture is a PNG by content.
  assert.deepEqual(sniffImage(await loadFixtureBytes('png-named-jpg.jpg')), {
    format: 'png',
    supported: true,
  })
})

test('sniffImage names recognized-but-unsupported image formats', () => {
  const cases: Array<[Buffer, string]> = [
    [Buffer.from([0x42, 0x4d, 0x00, 0x00]), 'bmp'], // "BM"
    [Buffer.concat([Buffer.from('II*\0'), Buffer.alloc(8)]), 'tiff'],
    [Buffer.concat([Buffer.from('MM\0*'), Buffer.alloc(8)]), 'tiff'],
    [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]), 'heic'],
    [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmif1'), Buffer.alloc(8)]), 'heic'],
    [Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(8)]), 'avif'],
  ]
  for (const [bytes, format] of cases) {
    assert.deepEqual(sniffImage(bytes), { format, supported: false }, format)
  }
})

test('sniffImage classifies SVG as an explicit non-raster format', () => {
  const plain = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
  const prolog = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>\n<svg width="10"></svg>',
  )
  for (const bytes of [plain, prolog]) {
    assert.deepEqual(sniffImage(bytes), { format: 'svg', supported: false })
  }
})

test('sniffImage returns null for non-images and unknown container brands', () => {
  assert.equal(sniffImage(Buffer.alloc(0)), null)
  assert.equal(sniffImage(Buffer.from('just some text, not an image')), null)
  // ISO-BMFF container, but not an image brand.
  assert.equal(
    sniffImage(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypisom'), Buffer.alloc(8)])),
    null,
  )
})

// ---------------------------------------------------------------------------
// processImageBytes: supported fixtures
// ---------------------------------------------------------------------------

test('transparent PNG round-trips as lossless PNG without upscaling', async () => {
  const result = await processImageBytes(await loadFixtureBytes('transparent.png'), {
    name: 'transparent.png',
  })
  assert.ok(result.ok)
  assert.equal(result.image.mimeType, 'image/png')
  assert.equal(result.image.width, 64)
  assert.equal(result.image.height, 64)
  assert.equal(result.image.originalFormat, 'png')
  assert.equal(result.image.originalMimeType, 'image/png')
  assert.equal(result.image.animated, false)
  assert.equal(result.image.scaleX, 1)
  assert.equal(result.image.scaleY, 1)
  // Alpha survives: the left half is opaque blue, the right half transparent.
  const meta = await sharp(result.image.bytes).metadata()
  assert.equal(meta.hasAlpha, true)
})

test('EXIF orientation is applied, recorded, and stripped from the send version', async () => {
  const result = await processImageBytes(await loadFixtureBytes('exif-orientation.jpg'), {
    name: 'exif-orientation.jpg',
  })
  assert.ok(result.ok)
  // Stored 64x48 with orientation 6 → oriented 48x64.
  assert.equal(result.image.originalWidth, 64)
  assert.equal(result.image.originalHeight, 48)
  assert.equal(result.image.orientedOriginalWidth, 48)
  assert.equal(result.image.orientedOriginalHeight, 64)
  assert.equal(result.image.exifOrientation, 6)
  assert.equal(result.image.width, 48)
  assert.equal(result.image.height, 64)
  assert.equal(result.image.originalMimeType, 'image/jpeg')
  // The send version carries no orientation tag: it is already upright.
  const meta = await sharp(result.image.bytes).metadata()
  assert.equal(meta.orientation, undefined)
})

test('static WebP and single-frame GIF process as non-animated', async () => {
  for (const name of ['static.webp', 'single-frame.gif']) {
    const result = await processImageBytes(await loadFixtureBytes(name), { name })
    assert.ok(result.ok, name)
    assert.equal(result.image.animated, false, name)
    assert.equal(result.image.width, 64, name)
    assert.equal(result.image.height, 64, name)
  }
})

test('animated GIF and animated WebP send the first frame, annotated', async () => {
  const gif = await processImageBytes(await loadFixtureBytes('animated.gif'), {
    name: 'animated.gif',
  })
  assert.ok(gif.ok)
  assert.equal(gif.image.animated, true)
  assert.equal(gif.image.width, 16)
  assert.equal(gif.image.height, 16)
  assert.equal(gif.image.originalMimeType, 'image/gif')
  // Frame 1 of the fixture is blue (40,100,200); frame 3 is green. PNG output
  // is lossless, so the pixel identifies the frame exactly.
  assert.deepEqual(await decodedPixel(gif.image.bytes, 0, 0), [40, 100, 200])

  // No animated-WebP fixture is committed; derive one losslessly from the GIF
  // (reading with `pages: -1` keeps every frame; WebP output then animates).
  const webpBytes = await sharp(await loadFixtureBytes('animated.gif'), { pages: -1 })
    .webp({ lossless: true })
    .toBuffer()
  const webp = await processImageBytes(webpBytes, { name: 'animated.webp' })
  assert.ok(webp.ok)
  assert.equal(webp.image.animated, true)
  assert.equal(webp.image.originalFormat, 'webp')
  assert.deepEqual(await decodedPixel(webp.image.bytes, 0, 0), [40, 100, 200])
})

test('a lying file extension cannot redirect processing', async () => {
  const result = await processImageBytes(await loadFixtureBytes('png-named-jpg.jpg'), {
    name: 'png-named-jpg.jpg',
  })
  assert.ok(result.ok)
  assert.equal(result.image.originalFormat, 'png')
  assert.equal(result.image.originalMimeType, 'image/png')
  assert.equal(result.image.mimeType, 'image/png')
})

// ---------------------------------------------------------------------------
// processImageBytes: failures with distinguishable reasons
// ---------------------------------------------------------------------------

test('corrupt and non-image bytes fail with decode-failed', async () => {
  const corrupt = await processImageBytes(await loadFixtureBytes('corrupt.png'), {
    name: 'corrupt.png',
  })
  assert.ok(!corrupt.ok)
  assert.equal(corrupt.reason, 'decode-failed')

  const text = await processImageBytes(Buffer.from('hello, world', 'utf8'), {
    name: 'note.txt',
  })
  assert.ok(!text.ok)
  assert.equal(text.reason, 'decode-failed')
})

test('BMP/HEIC/AVIF and SVG inputs fail with unsupported-format and a way out', async () => {
  const bmp = await processImageBytes(
    Buffer.concat([Buffer.from('BM'), Buffer.alloc(64, 0xab)]),
    { name: 'logo.bmp' },
  )
  assert.ok(!bmp.ok)
  assert.equal(bmp.reason, 'unsupported-format')
  assert.match(bmp.message, /convert it to PNG or JPEG first/)

  const heic = await processImageBytes(
    Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64, 0xab)]),
    { name: 'photo.heic' },
  )
  assert.ok(!heic.ok)
  assert.equal(heic.reason, 'unsupported-format')

  const svg = await processImageBytes(
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'),
    { name: 'icon.svg' },
  )
  assert.ok(!svg.ok)
  assert.equal(svg.reason, 'unsupported-format')
  assert.match(svg.message, /text semantics/)
})

test('oversize input bytes and oversize pixel counts fail with image-too-large', async () => {
  const bytes = await loadFixtureBytes('transparent.png')
  const tooManyBytes = await processImageBytes(bytes, {
    name: 'transparent.png',
    maxInputBytes: 100,
  })
  assert.ok(!tooManyBytes.ok)
  assert.equal(tooManyBytes.reason, 'image-too-large')
  assert.match(tooManyBytes.message, /bytes/)

  const tooManyPixels = await processImageBytes(bytes, {
    name: 'transparent.png',
    maxDecodedPixels: 1000,
  })
  assert.ok(!tooManyPixels.ok)
  assert.equal(tooManyPixels.reason, 'image-too-large')
  assert.match(tooManyPixels.message, /pixels/)
})

// ---------------------------------------------------------------------------
// The compression ladder
// ---------------------------------------------------------------------------

// Rung sizes measured for the seeded noise below at a 400px long edge
// (full PNG ≈ 433 KB, palette PNG ≈ 160 KB, JPEG q85 ≈ 81 KB); budgets sit
// well clear of both neighbours so encoder drift cannot flip a rung.
const NOISE_LONG_EDGE = 400

test('the ladder prefers lossless PNG when it fits the budget', async () => {
  const source = await noiseImage(800, 800)
  const result = await processImageBytes(source, {
    name: 'noise.png',
    sendLongEdge: NOISE_LONG_EDGE,
    maxSendBytes: 600_000,
  })
  assert.ok(result.ok)
  assert.equal(result.image.mimeType, 'image/png')
  assert.equal(result.image.width, 400)
  assert.equal(result.image.height, 400)
  assert.equal(result.image.scaleX, 2)
  assert.equal(result.image.scaleY, 2)
  // Lossless rung: the send version decodes to exactly the resized source.
  const expected = await sharp(source)
    .resize({ width: 400, height: 400, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer()
  const actual = await sharp(result.image.bytes).raw().toBuffer()
  assert.equal(actual.length, expected.length)
  assert.deepEqual([...actual.subarray(0, 64)], [...expected.subarray(0, 64)])
  assert.ok(actual.equals(expected), 'send version is not pixel-identical to the resized source')
})

test('the palette-PNG rung kicks in when full PNG is over budget', async () => {
  const source = await noiseImage(800, 800)
  const result = await processImageBytes(source, {
    name: 'noise.png',
    sendLongEdge: NOISE_LONG_EDGE,
    maxSendBytes: 200_000,
  })
  assert.ok(result.ok)
  assert.equal(result.image.mimeType, 'image/png')
  assert.ok(result.image.bytes.byteLength <= 200_000)
  // Palette output: at most 256 distinct colors.
  const { data, info } = await sharp(result.image.bytes).raw().toBuffer({ resolveWithObject: true })
  const colors = new Set<string>()
  for (let offset = 0; offset < data.length; offset += info.channels) {
    colors.add(`${data[offset]},${data[offset + 1]},${data[offset + 2]}`)
  }
  assert.ok(colors.size <= 256, `palette PNG has ${colors.size} colors`)
})

test('PNG rungs answer to the tighter PNG cap, not the send budget', async () => {
  const source = await noiseImage(800, 800)
  const result = await processImageBytes(source, {
    name: 'noise.png',
    sendLongEdge: NOISE_LONG_EDGE,
    maxSendBytes: 600_000,
    maxPngSendBytes: 120_000,
  })
  assert.ok(result.ok)
  assert.equal(result.image.mimeType, 'image/jpeg')
})

test('transparent input falling through to JPEG lands on white, never black', async () => {
  const source = await noiseImage(800, 800, true)
  const result = await processImageBytes(source, {
    name: 'overlay.png',
    sendLongEdge: NOISE_LONG_EDGE,
    // Between palette PNG (≈ 82 KB for this source) and JPEG q85 (≈ 38 KB),
    // so only the JPEG rung can fit.
    maxSendBytes: 60_000,
  })
  assert.ok(result.ok)
  assert.equal(result.image.mimeType, 'image/jpeg')
  const meta = await sharp(result.image.bytes).metadata()
  assert.equal(meta.hasAlpha, false)
  assert.equal(meta.format, 'jpeg')
  // The right half was fully transparent: flattened onto the explicit white
  // background, not an accidental black one.
  const flattened = await decodedPixel(result.image.bytes, 300, 200)
  for (const channel of flattened) {
    assert.ok(channel >= 240, `flattened pixel is not white: ${flattened.join(',')}`)
  }
  // The opaque left half keeps image content rather than becoming background.
  const content = await decodedPixel(result.image.bytes, 100, 200)
  assert.ok(
    !(content[0]! >= 240 && content[1]! >= 240 && content[2]! >= 240),
    `left half unexpectedly white: ${content.join(',')}`,
  )
})

test('the ladder has a floor: un-fittable images are rejected with a crop hint', async () => {
  const source = await noiseImage(800, 800)
  const result = await processImageBytes(source, {
    name: 'noise.png',
    sendLongEdge: NOISE_LONG_EDGE,
    maxSendBytes: 5_000,
  })
  assert.ok(!result.ok)
  assert.equal(result.reason, 'image-too-large')
  assert.match(result.message, /crop/)
})

test('a large screenshot lands inside the default budget without upscaling small ones', async () => {
  const screenshot = await gradientImage(3840, 2160)
  const result = await processImageBytes(screenshot, { name: 'screenshot.png' })
  assert.ok(result.ok)
  assert.equal(result.image.width, 2000)
  assert.equal(result.image.height, 1125)
  assert.ok(
    result.image.bytes.byteLength <= IMAGE_PROCESS_DEFAULTS.maxSendBytes,
    `send version is ${result.image.bytes.byteLength} bytes`,
  )
  assert.equal(result.image.orientedOriginalWidth, 3840)
  assert.equal(result.image.orientedOriginalHeight, 2160)
  assert.equal(result.image.scaleX, 3840 / 2000)
  assert.equal(result.image.scaleY, 2160 / 1125)

  // Small images are never enlarged: 64x64 stays 64x64 (covered above); an
  // image already inside the long edge keeps its exact dimensions.
  const small = await gradientImage(120, 90)
  const smallResult = await processImageBytes(small, { name: 'small.png' })
  assert.ok(smallResult.ok)
  assert.equal(smallResult.image.width, 120)
  assert.equal(smallResult.image.height, 90)
})

// ---------------------------------------------------------------------------
// The context caption
// ---------------------------------------------------------------------------

test('formatImageCaption matches the design-doc template', async () => {
  const screenshot = await gradientImage(3840, 2160)
  const result = await processImageBytes(screenshot, { name: 'screenshot.png' })
  assert.ok(result.ok)
  assert.equal(
    formatImageCaption(result.image, {
      index: 1,
      localPath: 'C:\\cache\\screenshot.png',
    }),
    '[Image 1: screenshot.png; cached original: C:\\cache\\screenshot.png; ' +
      'oriented original 3840x2160; supplied image 2000x1125; ' +
      'scale to oriented original: x=1.92, y=1.92.]',
  )
  // Without a cached original the segment is simply absent.
  assert.equal(
    formatImageCaption(result.image, { index: 2 }).startsWith('[Image 2: screenshot.png; oriented'),
    true,
  )

  // Animated images say so in the caption.
  const gif = await processImageBytes(await loadFixtureBytes('animated.gif'), {
    name: 'animated.gif',
  })
  assert.ok(gif.ok)
  assert.match(
    formatImageCaption(gif.image, { index: 3 }),
    /\[Image 3: animated\.gif \(first frame of an animated image\);/,
  )
})

// ---------------------------------------------------------------------------
// Orientation coordinate mapping (§8: more than a scale factor)
// ---------------------------------------------------------------------------

test('orientation mappings round-trip for every EXIF tag', () => {
  const width = 64
  const height = 48
  for (let tag = 1; tag <= 8; tag += 1) {
    const points = [
      { x: 0, y: 0 },
      { x: width - 1, y: 0 },
      { x: 0, y: height - 1 },
      { x: width - 1, y: height - 1 },
      { x: 23, y: 17 },
    ]
    const corner = orientedPointFromStored(tag, { x: 0, y: 0 }, width, height)
    for (const stored of points) {
      const oriented = orientedPointFromStored(tag, stored, width, height)
      const restored = storedPointFromOriented(
        tag,
        { x: oriented.x, y: oriented.y },
        oriented.width,
        oriented.height,
      )
      assert.deepEqual(
        { x: restored.x, y: restored.y },
        stored,
        `tag ${tag}: ${JSON.stringify(stored)} -> ${JSON.stringify(oriented)} -> back`,
      )
    }
    // The oriented image's dimensions match the mapping's claim.
    const dims = orientedDimensions(tag, width, height)
    assert.deepEqual({ width: dims.width, height: dims.height }, {
      width: corner.width,
      height: corner.height,
    })
    // Tags 5–8 swap axes; 1–4 do not.
    const swaps = tag >= 5
    assert.equal(dims.width === height, swaps, `tag ${tag} axes`)
  }
  // No orientation behaves as the identity.
  const noTag = orientedPointFromStored(undefined, { x: 5, y: 7 }, 64, 48)
  assert.deepEqual({ x: noTag.x, y: noTag.y }, { x: 5, y: 7 })
  const back = storedPointFromOriented(undefined, { x: 5, y: 7 }, 64, 48)
  assert.deepEqual({ x: back.x, y: back.y }, { x: 5, y: 7 })
})

test('orientation mapping agrees with sharp’s actual auto-rotation', async () => {
  const bytes = await loadFixtureBytes('exif-orientation.jpg')
  // Oriented pixel (0,0) of the fixture comes from stored pixel (0,47):
  // the mapping must predict exactly that source pixel.
  const predicted = storedPointFromOriented(6, { x: 0, y: 0 }, 48, 64)
  assert.deepEqual({ x: predicted.x, y: predicted.y, width: 64, height: 48 }, {
    x: 0,
    y: 47,
    width: 64,
    height: 48,
  })
  const actualOriented = await sharp(bytes)
    .rotate()
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .raw()
    .toBuffer()
  const predictedStored = await sharp(bytes)
    .extract({ left: predicted.x, top: predicted.y, width: 1, height: 1 })
    .raw()
    .toBuffer()
  assert.deepEqual([...actualOriented.subarray(0, 3)], [...predictedStored.subarray(0, 3)])
})

// ---------------------------------------------------------------------------
// Clipboard bitmap conversion (S13): the format bridge between what system
// clipboards offer and what the pipeline accepts.
// ---------------------------------------------------------------------------

test('convertImageBytesToPng re-encodes a TIFF with pixels intact', async () => {
  const tiff = await sharp({
    create: { width: 5, height: 4, channels: 3, background: { r: 210, g: 110, b: 60 } },
  }).tiff().toBuffer()
  const result = await convertImageBytesToPng(tiff, 'clipboard image')
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.ok(result.ok)
  assert.equal(sniffImage(result.bytes)?.format, 'png')
  const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 5)
  assert.equal(info.height, 4)
  assert.deepEqual([...data.subarray(0, 3)], [210, 110, 60])
})

test('convertImageBytesToPng re-encodes an AVIF clipboard bitmap', async () => {
  const avif = await sharp({
    create: { width: 3, height: 2, channels: 3, background: { r: 20, g: 200, b: 90 } },
  }).avif().toBuffer()
  const result = await convertImageBytesToPng(avif, 'clipboard image')
  assert.ok(result.ok, JSON.stringify(result))
  assert.equal(sniffImage(result.bytes)?.format, 'png')
})

test('convertImageBytesToPng refuses formats it cannot decode', async () => {
  // BMP is sniffable but the prebuilt libvips has no BMP loader; a clipboard
  // offering only BMP must be reported, not mangled through a decode attempt.
  const bmp = makeBmpBytes(3, 2)
  const bmpResult = await convertImageBytesToPng(bmp, 'clipboard image')
  assert.equal(bmpResult.ok, false)
  assert.ok(!bmpResult.ok)
  assert.equal(bmpResult.reason, 'unsupported-format')
  assert.match(bmpResult.message, /BMP/)

  const png = await loadFixtureBytes('transparent.png')
  const pngResult = await convertImageBytesToPng(png, 'clipboard image')
  assert.ok(!pngResult.ok)
  assert.equal(pngResult.reason, 'unsupported-format')

  const garbage = await convertImageBytesToPng(Buffer.from('not an image'), 'clipboard image')
  assert.ok(!garbage.ok)
  assert.equal(garbage.reason, 'unsupported-format')
  assert.match(garbage.message, /not a recognizable image/)
})

test('the two data-URL tiers fit their own boxes and never enlarge', async () => {
  // A picture larger than both boxes, and compressible enough to fit the first
  // rung: each tier lands on its own edge with the aspect ratio intact.
  const large = await gradientImage(3000, 1500)
  const thumbnail = await sharp(await renderThumbnailBytes(large)).metadata()
  assert.equal(thumbnail.width, 256)
  assert.equal(thumbnail.height, 128)
  const view = await sharp(await renderViewBytes(large)).metadata()
  assert.equal(view.width, 2048)
  assert.equal(view.height, 1024)

  // Incompressible pixels at the same size overflow the cap, so the ladder
  // steps down a rung rather than shipping a 5 MB data URL.
  const noisy = await renderViewBytes(await noiseImage(3000, 1500))
  const noisyMeta = await sharp(noisy).metadata()
  assert.ok(noisyMeta.width! < 2048, 'an over-cap render must shrink, not pass through')
  assert.ok(noisy.byteLength <= MAX_VIEW_BYTES)

  // Smaller than the box: unchanged, in both tiers. The viewer's zoom is what
  // magnifies a small original, not the encoder.
  const small = await noiseImage(120, 90)
  const smallView = await sharp(await renderViewBytes(small)).metadata()
  assert.equal(smallView.width, 120)
  assert.equal(smallView.height, 90)

  assert.ok((await renderThumbnailBytes(large)).byteLength <= MAX_THUMBNAIL_BYTES)
  assert.ok((await renderViewBytes(large)).byteLength <= MAX_VIEW_BYTES)
})
