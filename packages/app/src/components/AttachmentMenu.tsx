import React from 'react';
import { StyleSheet, View } from 'react-native';
import * as DropdownMenu from 'zeego/dropdown-menu';
import { Icon } from './Icon';
import { showNotImplemented } from '../notImplemented';
import { theme } from '../theme';

type AttachmentMenuProps = {
  onPickPhotos: () => void;
};

export function AttachmentMenu({ onPickPhotos }: AttachmentMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <View
          style={styles.button}
          accessible
          accessibilityRole="button"
          accessibilityLabel="Attach"
        >
          <Icon name="plus" size={22} color={theme.text} />
        </View>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        <DropdownMenu.Item key="camera" onSelect={showNotImplemented}>
          <DropdownMenu.ItemTitle>Camera</DropdownMenu.ItemTitle>
          <DropdownMenu.ItemIcon ios={{ name: 'camera' }} />
        </DropdownMenu.Item>
        <DropdownMenu.Item key="photos" onSelect={onPickPhotos}>
          <DropdownMenu.ItemTitle>Photos</DropdownMenu.ItemTitle>
          <DropdownMenu.ItemIcon ios={{ name: 'photo' }} />
        </DropdownMenu.Item>
        <DropdownMenu.Item key="files" onSelect={showNotImplemented}>
          <DropdownMenu.ItemTitle>Files</DropdownMenu.ItemTitle>
          <DropdownMenu.ItemIcon ios={{ name: 'paperclip' }} />
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

const styles = StyleSheet.create({
  // 44 pt touch target in the 40 pt slot the other bar buttons use.
  button: {
    width: 44,
    height: 44,
    margin: -2,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
