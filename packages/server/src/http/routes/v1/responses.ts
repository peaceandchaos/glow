import { defineWebSocketHandler } from 'nitro';
import { SocketConnection } from '../../../api';
import { sessionOwner } from '../../../auth';
import { services } from '../../../services';

const connections = new Map<string, SocketConnection>();

export default defineWebSocketHandler({
  // crossws awaits this hook and sends a thrown Response instead of upgrading.
  async upgrade(request) {
    const runtime = services();
    await sessionOwner(
      request.headers,
      runtime.allowedAppleUserIds,
      runtime.sessions,
    );
  },
  async message(peer, message) {
    let connection = connections.get(peer.id);
    if (!connection) {
      connection = new SocketConnection(peer.request.headers, services, {
        isOpen: () => peer.websocket.readyState === 1,
        send: text => peer.send(text),
        close: (code, reason) => peer.close(code, reason),
      });
      connections.set(peer.id, connection);
    }
    await connection.message(() => message.text());
  },
  close(peer) {
    connections.get(peer.id)?.close();
    connections.delete(peer.id);
  },
});
