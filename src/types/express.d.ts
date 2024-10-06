declare namespace Express {
  interface Request {
    userId: number;
    sessionId: string;
    token: string;
    user: {
      id: string;
      email: string;
      username: string;
    };
  }
}
