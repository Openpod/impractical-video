/** Paints immediately while the project workbench streams in, so entering a
 * project never reads as a frozen UI. */
export default function ProjectLoading() {
  return (
    <div aria-busy="true" aria-label="Opening project" className="route-loading">
      <span className="route-loading-bar" />
    </div>
  );
}
