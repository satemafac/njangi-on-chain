/**
 * A dummy endpoint that returns user salts.
 *
 * WARNING: Do not use in production! This service ignores the JWT token
 * and always returns the same salt for every user.
 *
 * To learn more about user salt management, see:
 * https://docs.sui.io/build/zk_login#user-salt-management
 */

'use strict';

import express from 'express';
import cors from 'cors';

const PORT = 5002;

const app = express();

// Parse JSON requests
app.use(express.json());

// Enable CORS for development
app.use(cors());

// WARNING: we're ignoring the JWT token and always returning the same salt.
app.post('/get-salt', (req: express.Request, res: express.Response) => {
    const salt = '129390038577185583942388216820280642146';
    res.json({ salt });
});

app.get('/ping', (req: express.Request, res: express.Response) => {
    res.status(200).send('pong\n');
});

app.listen(PORT, () => {
    console.log(`Salt service running on http://localhost:${PORT}`);
}); 