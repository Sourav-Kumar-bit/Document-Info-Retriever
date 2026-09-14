import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';

import { environment } from '../../environments/environment';
import { SessionService } from './session.service';

/**
 * Attaches X-Session-Id to every request bound for our API.
 *
 * The URL guard matters: without it the session id would ride along on every
 * outbound request, including third-party ones.
 */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(environment.apiUrl)) return next(req);

  const session = inject(SessionService);
  // HttpRequest is immutable — clone with changes, never mutate.
  return next(req.clone({ setHeaders: { 'X-Session-Id': session.id } }));
};
