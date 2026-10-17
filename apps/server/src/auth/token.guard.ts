import { createHash, timingSafeEqual } from "node:crypto";
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
} from "@nestjs/common";
import type { Request } from "express";

/** Hashes first so tokens of different lengths can be compared in constant time. */
const digest = (s: string) => createHash("sha256").update(s).digest();

/** Requires `Authorization: Bearer <WINGMAN_API_TOKEN>` on every reqeust. */
@Injectable()
export class TokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor() {
    const token = process.env.WINGMAN_API_TOKEN;
    if (!token) throw new Error("WINGMAN_API_TOKEN must be set");
    this.expected = digest(token);
  }

  canActivate(context: ExecutionContext): boolean {
    const header =
      context.switchToHttp().getRequest<Request>().headers.authorization ?? "";
    const given = header.startsWith("Bearer ") ? header.slice(7) : "";
    return timingSafeEqual(digest(given), this.expected);
  }
}
