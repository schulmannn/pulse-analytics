let selectedChannel: number | null = null;

export function getSelectedChannel(): number | null {
  return selectedChannel;
}

export function setSelectedChannel(id: number | null): void {
  selectedChannel = id;
}
