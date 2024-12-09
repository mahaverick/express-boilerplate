import { CorsOptions } from 'cors'
import { config } from 'dotenv'

import { CLIENT_URL } from '@/configs/constants/constants'

config()

const allowedOrigins: string[] = [
  'https://dev.boilerplate.com',
  'https://stage.boilerplate.com',
  'https://boilerplate.com',
]

const corsOptions: CorsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin === CLIENT_URL) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 204,
  exposedHeaders: ['WWW-Authenticate'],
}

export default corsOptions
