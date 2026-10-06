import { defineWebSocketHandler } from 'nitro';
import { socketRoute } from '../../../api';
import { services } from '../../../services';

export default defineWebSocketHandler(socketRoute(services));
