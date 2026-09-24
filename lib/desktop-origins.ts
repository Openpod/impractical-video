export const DESKTOP_PORT_START = 3210;
export const DESKTOP_PORT_END = 3220;

export const DESKTOP_AUTH_ORIGINS = Array.from(
  { length: DESKTOP_PORT_END - DESKTOP_PORT_START + 1 },
  (_, index) => `http://127.0.0.1:${DESKTOP_PORT_START + index}`,
);
