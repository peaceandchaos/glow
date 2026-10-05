/**
 * @format
 */

import { AppRegistry } from 'react-native';
import { clearPrewarmQueue } from 'react-native-nitro-websockets';
import App from './App';
import { name as appName } from './app.json';

// Earlier builds stored the OpenAI socket and its key for the native prewarmer,
// which replays them before JavaScript starts on every launch. Clearing the
// queue stops that from the next launch on and removes the stored key. Remove
// this call once every install has launched a build that makes it.
clearPrewarmQueue();

AppRegistry.registerComponent(appName, () => App);
