// src/controllers/base.controller.ts

import { Response } from 'express';

import { AppError } from '@/middlewares/error.middleware';
import { logger } from '@/utils/logger.utils';

export type ValidationErrors = {
  _errors?: string[] | undefined;
  [key: string]: ValidationErrors | string[] | undefined;
};

export abstract class BaseController {
  /**
   * Send Response with status code
   * @param {Response} res - Response object
   * @param {unknown} data - Data to be sent
   * @param {number} statusCode - Status code by default `200`
   * @param {string} message - Success message
   * @param {object} meta - Meta data about the response
   */
  protected sendResponse(
    res: Response,
    data: unknown,
    statusCode = 200,
    message = 'Success',
    meta = { timestamp: new Date().toISOString() },
  ) {
    res.status(statusCode).json({
      success: true,
      statusCode,
      message,
      data,
      meta,
    });
  }

  /**
   * Send Error response with status code
   * @param {Response} res - Response object
   * @param {string} message - Error Message
   * @param {number} statusCode - Status code by default `500`
   * @param {string} code - Error code by default `INTERNAL_SERVER_ERROR`
   * @param {object} errors - Detailed error messages for specific fields
   * @param {object} meta - Meta data about the error
   */
  protected sendError(
    res: Response,
    message: string,
    statusCode = 500,
    code = 'INTERNAL_SERVER_ERROR',
    errors?: ValidationErrors,
    meta = { timestamp: new Date().toISOString(), location: 'base' },
  ) {
    const error: AppError = new Error(message);
    error.statusCode = statusCode;
    error.code = code;

    logger.error(`Error: ${error.message} [${error.code}]`);

    res.status(error.statusCode).json({
      success: false,
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      errors,
      meta,
    });
  }
}
