declare module 'picomatch' {
  type Matcher = (input: string) => boolean

  interface Options {
    contains?: boolean
    dot?: boolean
    nocase?: boolean
  }

  function picomatch(pattern: string | string[], options?: Options): Matcher

  namespace picomatch {
    function scan(input: string): { base: string; glob: string; isGlob: boolean }
    function isMatch(input: string, pattern: string | string[], options?: Options): boolean
  }

  export default picomatch
}
