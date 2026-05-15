export function loadUserProfile(email: string) {
  return {
    email,
    roles: ["member"],
    resources: ["dashboard", "billing"]
  };
}
