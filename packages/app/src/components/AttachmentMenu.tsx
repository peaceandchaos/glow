import React from 'react';
import { StyleSheet } from 'react-native';
import * as DropdownMenu from 'zeego/dropdown-menu';
import { Glass } from './Glass';
import { Icon } from './Icon';
import { showNotImplemented } from '../notImplemented';
import { theme } from '../theme';

const CIRCLE = 44;

type AttachmentMenuProps = {
  onPickPhotos: () => void;
};

export function AttachmentMenu({ onPickPhotos }: AttachmentMenuProps) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Glass interactive style={styles.circle}>
          <Icon name="plus" size={22} color={theme.text} />
        </Glass>
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
  circle: {
    width: CIRCLE,
    height: CIRCLE,
    borderRadius: CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
