export const desktopAppName = "Semi-OS";

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${desktopAppName} desktop shell placeholder\n`);
}
