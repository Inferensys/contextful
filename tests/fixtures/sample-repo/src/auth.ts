import { z } from "zod";
import { loadUserProfile } from "./profile";

export interface LoginRequest {
  email: string;
  password: string;
}

export class AuthService {
  async login(request: LoginRequest) {
    const parsed = z.object({ email: z.string().email(), password: z.string() }).parse(request);
    return loadUserProfile(parsed.email);
  }
}

export const createAuthService = () => new AuthService();
