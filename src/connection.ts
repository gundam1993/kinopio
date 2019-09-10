import * as debug from 'debug';
import * as amqp from 'amqplib';

const log = debug('nameko-rpc');
let reconnectLock = false;

export async function connect(
  { hostname, port, vhost, username, password },
  onConnect
) {
  let connection;

  async function connect_() {
    const conn = await amqp.connect({
      hostname,
      port,
      vhost,
      username,
      password,
    });
    connection = conn;
    const newChannel = await conn.createChannel();
    newChannel.on('close', () => {
      log('channel close');
      reestablishConnection();
    });
    newChannel.on('error', () => {
      log('channel error');
      reestablishConnection();
    });
    log(`connected to amqp server: amqp://${hostname}:${port}/${vhost}`);
    await onConnect(connection, newChannel);
    return conn;
  }

  connection = await connect_();
  function reestablishConnection() {
    if (reconnectLock) {
      return;
    }
    reconnectLock = true;

    const interval = 2000;
    const maxAttemptes = 10;
    let numAttempts = 0;

    async function reconnect() {
      log(`trying to reconnect to amqp://${hostname}:${port}/${vhost}`);
      numAttempts += 1;
      const timeout = interval + numAttempts * interval;
      try {
        await connect_();
        reconnectLock = false;
      } catch (error) {
        if (numAttempts === maxAttemptes) {
          log(`failed to reconnect after ${maxAttemptes} tries`);
          throw new Error(`AMQP disconnected after ${maxAttemptes} attempts`);
        }
        log(`could not connect, trying again in ${timeout / 1000} seconds`);
        setTimeout(reconnect, interval);
      }
    }

    log(`connection closed, try to connect in ${interval / 1000} seconds`);
    setTimeout(reconnect, interval);
  }

  connection.on('close', () => {
    log('connection close');
    reestablishConnection();
  });

  connection.on('error', () => {
    log('connection error');
    reestablishConnection();
  });
}
