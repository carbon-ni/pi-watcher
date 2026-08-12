export function createGreeting(name: string): string {
  const normalizedName = name.trim();
  if (!normalizedName) return "Hello, world!";

  return `Hello, ${normalizedName}!`;
}
