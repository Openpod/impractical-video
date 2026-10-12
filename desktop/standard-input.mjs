import net from "node:net";
import process from "node:process";

/** On Windows, Electron replaces process.stdin with a stream that has already
 * ended, so nothing an agent writes to the hook or the MCP bridge arrives. The
 * pipe is still open on descriptor 0: read it there, the way Node itself does. */
export function standardInput() {
  if (process.platform !== "win32" || !process.versions.electron) {
    return process.stdin;
  }
  try {
    return new net.Socket({ fd: 0, readable: true, writable: false });
  } catch {
    // Not a pipe: started by hand, with nothing to read.
    return process.stdin;
  }
}
