/**
 * Ambient types for `@mixmark-io/domino`, the HTML parser Turndown already
 * carries for its own Node build.
 *
 * The package ships `lib/index.d.ts`, but it declares `module 'domino'` and
 * describes every node with the DOM lib's globals — and that lib is the one
 * thing this program's `lib` deliberately leaves out (`tsconfig.domtest.json`
 * explains why). The declarations below name only the members `WebFetch`'s
 * extraction uses, in structural types of our own, so importing the parser
 * never drags `document` into the host program.
 */
declare module '@mixmark-io/domino' {
  export interface DomNodeList<T> {
    readonly length: number
    readonly [index: number]: T
    item(index: number): T | null
  }

  export interface DomNode {
    readonly nodeName: string
    readonly nodeType: number
    readonly textContent: string | null
    readonly parentNode: DomNode | null
    readonly parentElement: DomElement | null
    readonly childNodes: DomNodeList<DomNode>
    removeChild<T extends DomNode>(child: T): T
    appendChild<T extends DomNode>(child: T): T
  }

  export interface DomElement extends DomNode {
    readonly tagName: string
    readonly id: string
    readonly className: string
    readonly outerHTML: string
    readonly firstElementChild: DomElement | null
    innerHTML: string
    getAttribute(name: string): string | null
    setAttribute(name: string, value: string): void
    removeAttribute(name: string): void
    hasAttribute(name: string): boolean
    matches(selector: string): boolean
    querySelector(selector: string): DomElement | null
    querySelectorAll(selector: string): DomNodeList<DomElement>
  }

  export interface DomDocument extends DomNode {
    readonly documentElement: DomElement
    readonly body: DomElement | null
    title: string
    createElement(tagName: string): DomElement
    querySelector(selector: string): DomElement | null
    querySelectorAll(selector: string): DomNodeList<DomElement>
  }

  export function createDocument(html?: string, force?: boolean): DomDocument

  const domino: { createDocument: typeof createDocument }
  export default domino
}