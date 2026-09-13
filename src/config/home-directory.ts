import { homedir } from 'os';

/** Config discovery's lookup seam; the default retains the existing precedence. */
export const configHomeDirectory = {
  get: (): string => process.env.HOME || homedir(),
};
