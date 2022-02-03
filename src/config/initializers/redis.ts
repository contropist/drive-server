import IORedis from 'ioredis';
import Logger from '../../lib/logger';

export default class Redis {
  private static instance: IORedis.Redis;

  static getInstance(): IORedis.Redis {
    if (Redis.instance) {
      return Redis.instance;
    }

    const config = {
      host: 'redis',
      password: process.env.REDIS_PASSWORD,
    };

    Redis.instance = new IORedis(config);

    const logger = Logger.getInstance();

    Redis.instance.on('connect', () => logger.info('Connected to Redis'));
    Redis.instance.on('ready', () => logger.info('Redis is ready'));
    Redis.instance.on('error', (err) => logger.error('Redis error', err));

    Redis.instance.defineCommand('refreshLock', {
      numberOfKeys: 1,
      lua: `if redis.call("get", KEYS[1]) == ARGV[1]
            then 
              return redis.call("expire", KEYS[1], 15)
            else
              return 0
            end`,
    });

    Redis.instance.defineCommand('releaseLock', {
      numberOfKeys: 1,
      lua: `if redis.call("get", KEYS[1]) == ARGV[1]
            then 
              return redis.call("del", KEYS[1])
            else
              return 0
            end`,
    });

    return Redis.instance;
  }
}
