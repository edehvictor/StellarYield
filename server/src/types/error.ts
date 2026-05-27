export interface ErrorResponse {
  error: string;
  message: string;
  requestId?: string;
  details?: unknown;
}