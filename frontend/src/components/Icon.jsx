/** One of the inline SVG icons from ui/icons. `display: contents` keeps the layout identical to a bare <svg>. */
export default function Icon({ html }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: html }} />;
}
