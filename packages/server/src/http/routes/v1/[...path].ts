import { defineHandler } from 'nitro';
import { handleRequest } from '../../../api';
import { services } from '../../../services';

export default defineHandler(event => handleRequest(event.req, services()));
