import { NextFunction, Request, Response } from 'express';
import { AnyZodObject, ZodError } from 'zod';

/**
 * Middleware to validate request body using Zod
 *
 * @param {AnyZodObject} schema - Zod schema to validate the request body
 * @returns {Promise<void>} - Middleware function
 */
export const zodValidate =
  (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      await schema.parseAsync(req.body);
      return next();
    } catch (error) {
      if (error instanceof ZodError) {
        return res.status(422).json({
          success: false,
          message: 'Validation failed',
          code: 'VALIDATION_ERROR',
          statusCode: 422,
          errors: error.format(),
          meta: { timestamp: new Date().toISOString() },
        });
      }

      return res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
        statusCode: 500,
        errors: null,
        meta: { timestamp: new Date().toISOString(), location: 'validation' },
      });
    }
  };
