export function add(left: number, right: number): number {
  return left + right;
}

export function formatUserName(user: { name: string }): string {
  return user.name.trim();
}
