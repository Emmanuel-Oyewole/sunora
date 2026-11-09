import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

const MAX_USER_AGENT_LENGTH = 512;

/** Client address and user agent, for sessions and the audit log. */
export const Ctx = createParamDecorator((_data: unknown, context: ExecutionContext): RequestContext => {
  const req = context.switchToHttp().getRequest<Request>();
  return {
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, MAX_USER_AGENT_LENGTH),
  };
});
