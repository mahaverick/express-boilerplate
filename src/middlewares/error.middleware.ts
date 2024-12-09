// src/middleware/error.middleware.ts

import { NextFunction, Request, Response } from 'express'

import { logger } from '@/utils/logger.utils'

export interface AppError extends Error {
  success?: boolean
  statusCode?: number
  code?: string
  errors?: Record<string, string>
  meta?: object
}

/**
 * Error handler
 * It will log all the errors using winston logger
 *
 * @param {AppError} err - Error Object
 * @param {Request} req - Request object
 * @param {Response} res - Response object
 * @param {NextFunction} next - Next function
 */
export const errorHandler = (err: AppError, req: Request, res: Response, next: NextFunction) => {
  const statusCode = err.statusCode || 500
  const code = err.code || 'INTERNAL_SERVER_ERROR'
  const message = err.message || 'Something went wrong'
  const errors = err.errors || null
  const meta = err.meta || { timestamp: new Date().toISOString(), location: 'error.middleware' }

  logger.error(`${statusCode} - ${message} - ${req.originalUrl} - ${req.method} - ${req.ip}`)

  res.status(statusCode).json({
    success: false,
    message,
    code: code,
    statusCode,
    errors,
    meta,
  })

  next(err)
}
