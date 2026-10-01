import type { Request, Response, NextFunction } from 'express';
import { ValidationError } from './validate.js';
import { WorkflowError } from './services/workflow.js';
import { isApprovalConflict } from './services/allocation/approval.js';

const isProduction = () => process.env.NODE_ENV === 'production';

export function sendError(res: Response, err: unknown, fallback: string) {
  if (err instanceof ValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (isApprovalConflict(err)) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof WorkflowError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const pgCode = (err as { code?: string })?.code;
  if (pgCode === '23505') {
    // Database backstop for "one active assignment per resource" (see migration 4).
    const constraint = (err as { constraint?: string }).constraint ?? '';
    if (constraint === 'resource_one_active_assignment' || String((err as Error).message).includes('resource_one_active_assignment')) {
      res.status(409).json({ error: 'This unit already has an active assignment. Refresh recommendations and try again.', code: 'allocation_conflict' });
      return;
    }
    res.status(409).json({ error: 'That record already exists' });
    return;
  }
  if (pgCode === '23514' || pgCode === '22P02') {
    res.status(400).json({ error: 'Invalid value' });
    return;
  }
  console.error(`[error] ${fallback}:`, err);
  res.status(500).json({ error: fallback, details: isProduction() ? undefined : String(err) });
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/** Wraps an async route so any thrown error becomes a JSON error response. */
export function route(fallback: string, handler: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      if (res.headersSent) {
        console.error(`[error] ${fallback} (after response started):`, err);
        return;
      }
      sendError(res, err, fallback);
    }
  };
}
