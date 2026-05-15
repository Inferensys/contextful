import { createAuthService } from "./auth";

test("login loads user resources", async () => {
  const service = createAuthService();
  const profile = await service.login({ email: "person@example.com", password: "secret" });
  expect(profile.resources).toContain("dashboard");
});
