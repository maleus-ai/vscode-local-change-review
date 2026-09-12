export function nowIso(): string {
  return new Date().toISOString();
}

let counter = 0;
export function newId(prefix: string): string {
  counter = (counter + 1) % 0xffff;
  const random = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}${random}`;
}

export function newSessionId(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `session-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
