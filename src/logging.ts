import winston, { format, transports } from 'winston';
import WinstonCloudWatch from 'winston-cloudwatch';
import { getConfig } from './config';

const date = new Date();
const logStreamName = date.toDateString() + ' - ' + date.getTime();
const config = getConfig();

export const createLogger = (label: string): winston.Logger => {
  const logger = winston.createLogger({
    level: 'info',
    format: format.combine(
      format.label({ label }),
      format.printf(info => {
        return [info.timestamp, info.level, info.label, info.component, '-', info.message]
          .filter(x => !!x)
          .join(' ');
      })
    ),
    transports: process.env.pm_id ? [] : [new transports.Console()],
  });

  const { awsAccessKeyId, awsSecretAccessKey, awsRegion } = config;

  // Implicitly infer the environment and attach AWS CWL. This should really be in an environment
  // where we can log to stdout/err then have a log aggregator to push to some log service.
  if (awsAccessKeyId && awsSecretAccessKey && awsRegion) {
    const logGroupName =
      process.env.name === 'perps-keeper-goerli'
        ? 'perps-keeper-staging'
        : 'perps-keeper-production';

    logger.add(
      new WinstonCloudWatch({
        logGroupName,
        logStreamName,
        messageFormatter: ({ level, message }) => `${level.toUpperCase()} [${label}] ${message}`,
        awsOptions: {
          region: awsRegion,
          credentials: {
            accessKeyId: awsAccessKeyId,
            secretAccessKey: awsSecretAccessKey,
          },
        },
      })
    );
  }

  return logger;
};
