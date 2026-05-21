import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { useCameraStore } from '../src/store/cameras';
import { createVigilatusMock, installVigilatusMock } from './helpers/mockVigilatus';

function resetStore(): void {
  useCameraStore.setState({
    cameras: [],
    selectedId: null,
    showPreviews: true,
    showTimeline: true,
    showDebugOverlay: false,
    previewPosition: 'right',
    playbackMode: 'live',
    playbackTime: null,
    playbackStartTime: null,
    recordings: [],
    recordingEvents: [],
    recordingsLoading: false,
    recordingsError: null,
  });
}

describe('App', () => {
  beforeEach(() => {
    installVigilatusMock(createVigilatusMock());
    resetStore();
  });

  it('opens and closes the add camera modal from the empty state', async () => {
    const mock = createVigilatusMock();
    installVigilatusMock(mock);

    render(<App />);

    await waitFor(() => expect(mock.cameras.getAll).toHaveBeenCalled());
    expect(screen.getByTestId('empty-state')).toBeVisible();

    fireEvent.click(screen.getByTestId('empty-state-add-camera'));
    expect(screen.getByTestId('add-camera-modal')).toBeVisible();

    fireEvent.click(screen.getByTestId('add-camera-close'));
    await waitFor(() => expect(screen.queryByTestId('add-camera-modal')).not.toBeInTheDocument());
  });
});
