import { TrajectoryDB } from '../db.js';

export function tempDB(): TrajectoryDB {
  return new TrajectoryDB(':memory:');
}
