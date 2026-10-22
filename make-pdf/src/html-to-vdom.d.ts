declare module 'html-to-vdom' {
  export default function HTMLToVDOM(dependencies: { VNode: Function; VText: Function }): (html: string) => any;
}
