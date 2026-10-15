import 'react-native';
import {fireEvent, render, waitFor} from '@testing-library/react-native';
import * as React from 'react';

import {App} from '../src/App';

describe('App', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() => new Promise(() => {})) as typeof fetch;
  });

  it('shows all four clubs in its offline sample state', () => {
    const screen = render(<App />);
    expect(screen.getByText('Garden Circle')).toBeTruthy();
    expect(screen.getByText('Slow Morning Chess')).toBeTruthy();
    expect(screen.getByText('Old Film Songs & Stories')).toBeTruthy();
    expect(screen.getByText('Postcard Sketching')).toBeTruthy();
    expect(screen.getByTestId('filter-All')).toBeTruthy();
    expect(screen.getByTestId('filter-Gardening')).toBeTruthy();
    expect(screen.getByTestId('main-content-scroll')).toBeTruthy();
    expect(screen.getByText('Use Left and Right to browse clubs · Down to see more')).toBeTruthy();
    expect(screen.getByTestId('activity-action-garden-circle')).toBeTruthy();
  });

  it('offers a clear empty state for upcoming gatherings', () => {
    const screen = render(<App />);
    fireEvent.press(screen.getByTestId('tab-groups'));
    expect(screen.getByText('Your upcoming gatherings')).toBeTruthy();
    expect(screen.getByText('Your seat is waiting')).toBeTruthy();
    expect(screen.getByTestId('empty-explore')).toBeTruthy();
  });

  it('shows the shared Saathi server state and sends a join action to its API', async () => {
    const state = {
      user: {name: 'Asha', preferences: {interests: ['gardening'], captions: true}},
      nextSession: null,
      joinedSessions: [],
      allActivities: [{id: 'garden-circle', title: 'Garden Circle', description: 'Planting herbs & balcony greens', recurrence: 'Sundays · 4:00 PM', tags: ['gardening'], participation_modes: ['observe'], access: ['Captions'], joined: false}],
      activeGuide: null,
      latestHelpStatus: null,
    };
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({ok: true, json: async () => state})
      .mockResolvedValueOnce({ok: true})
      .mockResolvedValue({ok: true, json: async () => state});
    global.fetch = fetchMock as typeof fetch;

    const screen = render(<App />);
    await waitFor(() => expect(screen.getByText('Synced with Saathi demo')).toBeTruthy());
    fireEvent.press(screen.getByTestId('activity-action-garden-circle'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      'http://10.0.2.2:4173/api/activities/garden-circle/join',
      {method: 'POST'},
    ));
  });
});
