import { describe, it, expect, beforeEach } from '@jest/globals';
import { Request, Response } from 'express';
import { sendError, sendErrorWithRequest } from '../errorResponse';

describe('errorResponse', () => {
    let mockRes: Partial<Response>;
    let mockReq: Partial<Request>;

    beforeEach(() => {
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        };
        mockReq = {};
    });

    describe('sendError', () => {
        it('sends error response with required fields', () => {
            sendError(mockRes as Response, 400, 'BAD_REQUEST', 'Invalid input');

            expect(mockRes.status).toHaveBeenCalledWith(400);
            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'BAD_REQUEST',
                message: 'Invalid input',
            });
        });

        it('includes requestId when provided', () => {
            sendError(
                mockRes as Response,
                400,
                'BAD_REQUEST',
                'Invalid input',
                undefined,
                'req-123'
            );

            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'BAD_REQUEST',
                message: 'Invalid input',
                requestId: 'req-123',
            });
        });

        it('includes details when provided', () => {
            const details = { field: 'email', reason: 'invalid format' };
            sendError(
                mockRes as Response,
                400,
                'VALIDATION_ERROR',
                'Validation failed',
                details
            );

            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'VALIDATION_ERROR',
                message: 'Validation failed',
                details,
            });
        });

        it('includes both requestId and details', () => {
            const details = { field: 'email' };
            sendError(
                mockRes as Response,
                400,
                'VALIDATION_ERROR',
                'Validation failed',
                details,
                'req-456'
            );

            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'VALIDATION_ERROR',
                message: 'Validation failed',
                requestId: 'req-456',
                details,
            });
        });

        it('does not include requestId when undefined', () => {
            sendError(
                mockRes as Response,
                500,
                'INTERNAL_ERROR',
                'Server error',
                undefined,
                undefined
            );

            const callArg = (mockRes.json as any).mock.calls[0][0];
            expect(callArg).not.toHaveProperty('requestId');
        });

        it('does not include details when undefined', () => {
            sendError(mockRes as Response, 500, 'INTERNAL_ERROR', 'Server error');

            const callArg = (mockRes.json as any).mock.calls[0][0];
            expect(callArg).not.toHaveProperty('details');
        });

        it('handles various HTTP status codes', () => {
            const statusCodes = [400, 401, 403, 404, 500, 503];

            statusCodes.forEach((code) => {
                mockRes.status = jest.fn().mockReturnThis();
                sendError(mockRes as Response, code, 'ERROR', 'Error message');
                expect(mockRes.status).toHaveBeenCalledWith(code);
            });
        });
    });

    describe('sendErrorWithRequest', () => {
        it('extracts requestId from request and includes it in response', () => {
            const requestId = 'req-789';
            mockReq = {
                requestId,
            } as any;

            sendErrorWithRequest(
                mockReq as Request,
                mockRes as Response,
                400,
                'BAD_REQUEST',
                'Invalid input'
            );

            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'BAD_REQUEST',
                message: 'Invalid input',
                requestId,
            });
        });

        it('handles missing requestId gracefully', () => {
            mockReq = {} as any;

            sendErrorWithRequest(
                mockReq as Request,
                mockRes as Response,
                500,
                'INTERNAL_ERROR',
                'Server error'
            );

            const callArg = (mockRes.json as any).mock.calls[0][0];
            expect(callArg).not.toHaveProperty('requestId');
        });

        it('includes details along with requestId', () => {
            const requestId = 'req-999';
            const details = { reason: 'validation failed' };
            mockReq = {
                requestId,
            } as any;

            sendErrorWithRequest(
                mockReq as Request,
                mockRes as Response,
                400,
                'VALIDATION_ERROR',
                'Validation failed',
                details
            );

            expect(mockRes.json).toHaveBeenCalledWith({
                error: 'VALIDATION_ERROR',
                message: 'Validation failed',
                requestId,
                details,
            });
        });

        it('sets correct HTTP status code', () => {
            mockReq = { requestId: 'req-123' } as any;

            sendErrorWithRequest(
                mockReq as Request,
                mockRes as Response,
                403,
                'FORBIDDEN',
                'Access denied'
            );

            expect(mockRes.status).toHaveBeenCalledWith(403);
        });
    });

    describe('requestId presence in error responses', () => {
        it('ensures requestId is always present when using sendErrorWithRequest', () => {
            const testCases = [
                { requestId: 'req-1', statusCode: 400 },
                { requestId: 'req-2', statusCode: 401 },
                { requestId: 'req-3', statusCode: 500 },
            ];

            testCases.forEach(({ requestId, statusCode }) => {
                mockReq = { requestId } as any;
                mockRes.status = jest.fn().mockReturnThis();
                mockRes.json = jest.fn().mockReturnThis();

                sendErrorWithRequest(
                    mockReq as Request,
                    mockRes as Response,
                    statusCode,
                    'ERROR',
                    'Error message'
                );

                const callArg = (mockRes.json as any).mock.calls[0][0];
                expect(callArg.requestId).toBe(requestId);
            });
        });
    });
});
