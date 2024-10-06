import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from 'dotenv';
import express, { json, urlencoded } from 'express';
import helmet from 'helmet';

import corsOptions from '@/configs/cors/cors-options';
import { errorHandler } from '@/middlewares/error.middleware';
import routes from '@/routes/index.routes';
import { logger } from '@/utils/logger.utils';

config();

const app = express();

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(helmet());
app.use(cookieParser());

app.use(json());
app.use(urlencoded({ extended: false }));

// Use the centralized routes
app.use('/api', routes);

// Use the error handler middleware
app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app
  .listen(PORT, () => {
    logger.info(`Server is running on port http://localhost:${PORT}`);
  })
  .on('error', (error) => {
    // gracefully handle error
    logger.error(error);
    throw new Error(error.message);
  });
