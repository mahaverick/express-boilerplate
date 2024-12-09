import { createLogger, format, transports } from 'winston'

import { ENV } from '@/configs/constants/constants'

export const logger = createLogger({
  level: 'info',
  format: format.combine(format.timestamp(), format.json()),
  transports: [
    new transports.Console(),
    new transports.File({ filename: 'error.log', level: 'error' }),
    new transports.File({ filename: 'combined.log' }),
  ],
})

// If we're not in production, log to the console as well
if (ENV !== 'production') {
  logger.add(
    new transports.Console({
      format: format.simple(),
    })
  )
}
