/** Paints immediately while a shell page (home, explore, library) streams in,
 * so leaving a project never reads as a frozen UI. */
export default function ShellLoading() {
  return (
    <div aria-busy="true" aria-label="Loading" className="route-loading">
      <span className="route-loading-bar" />
    </div>
  );
}
