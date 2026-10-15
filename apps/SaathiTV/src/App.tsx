import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {TVFocusGuideView} from '@amazon-devices/react-native-kepler';

// For Vega Virtual Device, 10.0.2.2 routes to the host machine. Start Saathi
// with HOST=0.0.0.0 so the virtual device can reach port 4173.
const API_BASE_URL = 'http://10.0.2.2:4173';
const POLL_MS = 2000;

type Activity = {
  id: string;
  title: string;
  description: string;
  recurrence: string;
  tags: string[];
  access: string[];
  participation_modes: string[];
  joined: boolean;
};

type Session = {id: string; title: string; topic: string; startsAt: string; recurrence: string; access: string[]};
type TvState = {
  user: {name: string; preferences: {interests: string[]; captions: boolean; textSize: 'large' | 'default'}};
  nextSession: {title: string; recurrence: string; startsAt: string} | null;
  joinedSessions: Session[];
  allActivities: Activity[];
  activeGuide: {title: string; currentStepNumber: number; totalSteps: number} | null;
  latestHelpStatus: {status: string} | null;
};

const filters = ['All', 'Gardening', 'Games', 'Music', 'Art'];
const fallbackActivities: Activity[] = [
  {id: 'garden-circle', title: 'Garden Circle', description: 'Planting herbs & balcony greens', recurrence: 'Sundays · 4:00 PM', tags: ['gardening', 'captions', 'observe-ok'], participation_modes: ['speak', 'choose', 'observe'], access: ['Captions', 'Written steps', 'Observing is welcome'], joined: false},
  {id: 'slow-chess', title: 'Slow Morning Chess', description: 'Untimed friendly tactics', recurrence: 'Tuesdays · 10:30 AM', tags: ['games', 'no-timer', 'text-moves'], participation_modes: ['speak', 'choose', 'text', 'observe'], access: ['No timer', 'Moves shown in text', 'Take a break at any time'], joined: false},
  {id: 'ragas-stories', title: 'Old Film Songs & Stories', description: 'Listening & trivia circle', recurrence: 'Thursdays · 6:00 PM', tags: ['music', 'captions', 'audio-described'], participation_modes: ['speak', 'choose', 'observe'], access: ['Captions', 'Audio-described notes', 'Listen or join the conversation'], joined: false},
  {id: 'chai-sketch', title: 'Postcard Sketching', description: 'Simple everyday drawing', recurrence: 'Saturdays · 11:00 AM', tags: ['art', 'stepwise', 'observe-ok'], participation_modes: ['speak', 'choose', 'text', 'observe'], access: ['Step-by-step prompts', 'Observing is welcome', 'No timed rounds'], joined: false},
];

const categoryFor = (activity: Activity) =>
  filters.slice(1).find((filter) => activity.tags.includes(filter.toLowerCase()));

export const App = () => {
  const [activities, setActivities] = useState(fallbackActivities);
  const [tvState, setTvState] = useState<TvState | null>(null);
  const [filter, setFilter] = useState('All');
  const [focusedId, setFocusedId] = useState('filter-All');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [connection, setConnection] = useState<'loading' | 'connected' | 'offline'>('loading');
  const largeText = tvState?.user.preferences.textSize === 'large';
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'explore' | 'groups' | 'chat'>('explore');
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const [chatSessionId] = useState(() => `tv-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`);
  const [chatMessages, setChatMessages] = useState<{role: 'assistant' | 'user'; text: string}[]>([
    {role: 'assistant', text: 'Hello Asha. Ask me about a club or a small task. You can also choose one of the suggested questions below.'},
  ]);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/tv/state`);
      if (!response.ok) throw new Error('Saathi server did not respond');
      const state = (await response.json()) as TvState;
      setTvState(state);
      setActivities(state.allActivities);
      setConnection('connected');
      setNotice('');
    } catch {
      setConnection('offline');
      setNotice('Saathi is offline. Some information may be out of date.');
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(() => refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const visibleActivities = useMemo(
    () => activities.filter((activity) => filter === 'All' || categoryFor(activity) === filter),
    [activities, filter],
  );

  const toggleMembership = useCallback(async (activity: Activity) => {
    setBusyId(activity.id);
    try {
      const action = activity.joined ? 'leave' : 'join';
      const response = await fetch(`${API_BASE_URL}/api/activities/${activity.id}/${action}`, {method: 'POST'});
      if (!response.ok) throw new Error('Could not update membership');
      await refresh();
    } catch {
      setConnection('offline');
      setNotice(`Could not confirm whether you ${activity.joined ? 'left' : 'joined'} ${activity.title}. Reconnect and check My gatherings.`);
    } finally {
      setBusyId(null);
    }
  }, [refresh]);

  const sendChat = async (suggested?: string) => {
    const message = (suggested ?? chatInput).trim();
    if (!message || chatBusy) return;
    setChatInput('');
    setChatBusy(true);
    setChatMessages((current) => [...current, {role: 'user', text: message}, {role: 'assistant', text: 'Saathi is checking…'}]);
    try {
      const response = await fetch(`${API_BASE_URL}/api/agent/chat`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({message, sessionId: chatSessionId}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Saathi could not answer just now.');
      const preview = result.uiAction?.previewData;
      const previewText = preview
        ? `\n\nReview before confirming\nTo: ${preview.recipient}\nMessage: ${preview.message}\nShared: ${preview.shares.join(', ')}\nNot shared: ${preview.notShared.join(', ')}\n\nThis is a preview only. Nothing was sent.`
        : '';
      setChatMessages((current) => [...current.slice(0, -1), {role: 'assistant' as const, text: `${result.reply}${previewText}`}].slice(-24));
      setConnection('connected');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Saathi could not answer just now.';
      setChatMessages((current) => [...current.slice(0, -1), {role: 'assistant' as const, text: `${detail} You can try again when the connection returns.`}].slice(-24));
    } finally {
      setChatBusy(false);
    }
  };

  const clearChat = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/agent/session/${encodeURIComponent(chatSessionId)}`, {method: 'DELETE'});
      if (!response.ok) throw new Error('Could not clear chat memory');
      setChatMessages([{role: 'assistant', text: 'Hello Asha. I cleared our earlier conversation. What would you like to explore now?'}]);
    } catch {
      setNotice('I could not clear the conversation just now. Check the connection and try again.');
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.brand}>saathi <Text style={styles.devanagari}>साथी</Text></Text>
          <Text style={styles.subtitle}>Your life. Your people. Your way.</Text>
        </View>
        <View style={styles.connection} accessibilityLiveRegion="polite">
          <View style={[styles.dot, connection === 'connected' ? styles.connected : connection === 'offline' ? styles.offline : styles.loading]} />
          <Text style={styles.connectionText}>{connection === 'connected' ? `Synced with Saathi demo · captions ${tvState?.user.preferences.captions ? 'on' : 'off'}` : connection === 'offline' ? 'Showing sample activities' : 'Connecting…'}</Text>
        </View>
      </View>

      <ScrollView
        testID="main-content-scroll"
        style={styles.mainScroll}
        contentContainerStyle={styles.mainContent}
        showsVerticalScrollIndicator
        directionalLockEnabled>
      <View style={styles.welcomeRow}>
        <View style={styles.welcomeCopy}>
          <Text style={styles.eyebrow}>A LITTLE COMPANY GOES A LONG WAY</Text>
          <Text style={[styles.heading, largeText && {fontSize: 40, lineHeight: 48}]}>Find your people, {tvState?.user.name ?? 'Asha'}.</Text>
          <Text style={[styles.lede, largeText && {fontSize: 20, lineHeight: 29}]}>Choose a club, join in your own way, or simply enjoy watching.</Text>
        </View>
        <View style={styles.nextCard}>
          <Text style={styles.nextLabel}>YOUR NEXT GATHERING</Text>
            <Text style={[styles.nextTitle, largeText && {fontSize: 24}]}>{tvState?.nextSession?.title ?? 'Pick a club to get started'}</Text>
            <Text style={[styles.nextTime, largeText && {fontSize: 17}]}>{tvState?.nextSession?.recurrence ?? 'Small groups · friendly pace'}</Text>
        </View>
      </View>

      <TVFocusGuideView style={styles.navRow}>
        {(['explore', 'groups', 'chat'] as const).map((item) => {
          const id = `tab-${item}`;
          const selected = view === item;
          return (
            <Pressable key={item} testID={id} accessibilityRole="tab" accessibilityState={{selected}} hasTVPreferredFocus={item === 'explore'} onFocus={() => setFocusedId(id)} onPress={() => setView(item)} style={[styles.navTab, selected && styles.navTabSelected, focusedId === id && styles.focused]}>
              <Text style={[styles.navText, selected && styles.navTextSelected]}>{item === 'explore' ? 'Explore clubs' : item === 'groups' ? `My gatherings${tvState?.joinedSessions.length ? ` (${tvState.joinedSessions.length})` : ''}` : 'Chat with Saathi'}</Text>
            </Pressable>
          );
        })}
      </TVFocusGuideView>

      {notice ? <Text style={styles.notice} accessibilityRole="alert" accessibilityLiveRegion="assertive">{notice}</Text> : null}

      {view === 'explore' ? (
        <>
          <View style={styles.filterSection}>
            <Text style={styles.sectionTitle}>Explore clubs</Text>
            <Text style={styles.scrollHint}>Use Left and Right to browse clubs · Down to see more</Text>
            <TVFocusGuideView style={styles.filterRow}>
              {filters.map((item) => {
                const id = `filter-${item}`;
                const selected = item === filter;
                return (
                  <Pressable key={item} testID={id} accessibilityRole="button" accessibilityState={{selected}} accessibilityLabel={`${item} activities`} onFocus={() => setFocusedId(id)} onPress={() => setFilter(item)} style={[styles.filterChip, selected && styles.filterSelected, focusedId === id && styles.focused]}>
                    <Text style={[styles.filterText, selected && styles.filterTextSelected]}>{item}</Text>
                  </Pressable>
                );
              })}
            </TVFocusGuideView>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.activityRow}>
            {visibleActivities.map((activity) => {
              const actionId = `activity-action-${activity.id}`;
              const focused = focusedId === actionId;
              return (
                <View key={activity.id} style={styles.activityCard}>
                  <Text style={styles.activityCategory}>{categoryFor(activity)?.toUpperCase() ?? 'CLUB'}</Text>
                  <Text style={[styles.activityTitle, largeText && {fontSize: 25, lineHeight: 32}]}>{activity.title}</Text>
                  <Text style={[styles.activityDescription, largeText && {fontSize: 17, lineHeight: 24}]}>{activity.description}</Text>
                  <Text style={[styles.recurrence, largeText && {fontSize: 17}]}>{activity.recurrence}</Text>
                  <View style={styles.accessList}>
                    {activity.access.slice(0, 2).map((access) => <Text key={access} style={[styles.accessText, largeText && {fontSize: 15, lineHeight: 21}]}>•  {access}</Text>)}
                  </View>
                  <Pressable
                    testID={actionId}
                    accessibilityRole="button"
                    accessibilityLabel={`${activity.joined ? 'Leave' : 'Join'} ${activity.title}`}
                    accessibilityHint={connection !== 'connected' ? 'Connect to Saathi to save this choice' : activity.joined ? 'Removes this club from your upcoming sessions' : 'Adds its recurring sessions to your upcoming gatherings'}
                    accessibilityState={{disabled: connection !== 'connected' || busyId === activity.id}}
                    disabled={connection !== 'connected' || busyId === activity.id}
                    onFocus={() => setFocusedId(actionId)}
                    onPress={() => { toggleMembership(activity); }}
                    style={[styles.actionButton, activity.joined && styles.leaveButton, (connection !== 'connected' || busyId === activity.id) && styles.actionDisabled, focused && styles.focused]}>
                    {busyId === activity.id ? <ActivityIndicator color="#102A35" /> : <Text style={styles.actionText}>{connection !== 'connected' ? 'Connect to join' : activity.joined ? 'Joined · Leave' : 'Join this club'}</Text>}
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        </>
      ) : view === 'groups' ? (
        <View style={styles.groupsContent}>
          <Text style={styles.sectionTitle}>Your upcoming gatherings</Text>
          {!tvState?.joinedSessions.length ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyTitle}>Your seat is waiting</Text>
              <Text style={styles.emptyCopy}>Join a recurring club and its next sessions will appear here.</Text>
              <Pressable testID="empty-explore" accessibilityRole="button" onFocus={() => setFocusedId('empty-explore')} onPress={() => setView('explore')} style={[styles.actionButton, focusedId === 'empty-explore' && styles.focused]}>
                <Text style={styles.actionText}>Explore clubs</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.activityRow}>
              {tvState.joinedSessions.map((session) => (
                <View key={session.id} style={styles.sessionCard}>
                  <Text style={styles.activityCategory}>A PLACE TO RETURN TO</Text>
                  <Text style={[styles.activityTitle, largeText && {fontSize: 25, lineHeight: 32}]}>{session.title}</Text>
                  <Text style={[styles.activityDescription, largeText && {fontSize: 17, lineHeight: 24}]}>{session.topic}</Text>
                  <Text style={styles.recurrence}>{new Date(session.startsAt).toLocaleDateString('en-IN', {weekday: 'long', day: 'numeric', month: 'long'})}</Text>
                  <Text style={styles.accessText}>{session.recurrence}</Text>
                  <Text style={styles.sessionNote}>Come as you are. You can listen, take part, or simply observe.</Text>
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      ) : (
        <View style={styles.chatPanel}>
          <View style={styles.chatHeader}>
            <Text style={styles.sectionTitle}>Chat with Saathi</Text>
            <Text style={styles.chatHint}>Use the remote to choose a suggestion or type a message.</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Start a new chat and clear recent memory" onFocus={() => setFocusedId('chat-clear')} onPress={clearChat} style={[styles.chatClear, focusedId === 'chat-clear' && styles.focused]}><Text style={styles.chatClearText}>Start a new chat</Text></Pressable>
          </View>
          <ScrollView style={styles.chatTranscript} contentContainerStyle={styles.chatTranscriptContent} showsVerticalScrollIndicator>
            {chatMessages.slice(-8).map((item, index) => (
              <View key={`${index}-${item.role}`} style={[styles.chatBubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
                <Text style={styles.chatSpeaker}>{item.role === 'user' ? 'YOU' : 'SAATHI'}</Text>
                <Text style={[styles.chatMessage, largeText && {fontSize: 18, lineHeight: 26}]}>{item.text}</Text>
              </View>
            ))}
          </ScrollView>
          <TVFocusGuideView style={styles.chatSuggestions}>
            {[
              ['Ask about gardening', 'Find a gardening group with captions'],
              ['Show a small guide', 'Show me a simple herb pot guide'],
              ['Review sharing', 'What will you share if I ask Maya for help?'],
            ].map(([label, prompt]) => (
              <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} onFocus={() => setFocusedId(`chat-${label}`)} onPress={() => sendChat(prompt)} style={[styles.chatSuggestion, focusedId === `chat-${label}` && styles.focused]}>
                <Text style={styles.chatSuggestionText}>{label}</Text>
              </Pressable>
            ))}
          </TVFocusGuideView>
          <View style={styles.chatComposer}>
            <TextInput
              testID="chat-input"
              accessibilityLabel="Message Saathi"
              accessibilityHint="Use the TV keyboard to type a message, then move to Send. Suggested questions are available above."
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="Ask Saathi…"
              placeholderTextColor="#64766D"
              multiline
              maxLength={1000}
              style={styles.chatInput}
              onFocus={() => setFocusedId('chat-input')}
            />
            <Pressable testID="chat-send" accessibilityRole="button" accessibilityLabel="Send message to Saathi" disabled={!chatInput.trim() || chatBusy} onFocus={() => setFocusedId('chat-send')} onPress={() => sendChat()} style={[styles.chatSend, focusedId === 'chat-send' && styles.focused, (!chatInput.trim() || chatBusy) && styles.actionDisabled]}>
              <Text style={styles.chatSendText}>{chatBusy ? 'Checking…' : 'Send'}</Text>
            </Pressable>
          </View>
          <Text style={styles.chatPrivacy}>Remembers up to 8 recent turns for 30 minutes idle. Start a new chat to clear them. Recent context may be sent to the configured AI provider. Help remains preview-only.</Text>
        </View>
      )}
      </ScrollView>

      <View style={styles.bottomBar}>
        <Text style={styles.bottomText}>{tvState?.joinedSessions.length ? `${tvState.joinedSessions.length} upcoming sessions · return any week` : 'No pressure to speak, move fast, or keep up.'}</Text>
        <Text style={styles.helpText}>{tvState?.latestHelpStatus ? `Help request: ${tvState.latestHelpStatus.status} · demo only` : 'Your activity choices stay yours.'}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#102A35', paddingHorizontal: 58, paddingVertical: 28},
  mainScroll: {flex: 1, minHeight: 0},
  mainContent: {flexGrow: 1, paddingBottom: 12},
  topBar: {height: 66, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  brand: {color: '#F4F1E8', fontSize: 28, fontWeight: '700', letterSpacing: 0.4},
  devanagari: {color: '#F3B86C', fontSize: 22, fontWeight: '500'},
  subtitle: {color: '#BDD0D3', fontSize: 15, marginTop: 1},
  connection: {flexDirection: 'row', alignItems: 'center', gap: 10},
  dot: {width: 10, height: 10, borderRadius: 5},
  connected: {backgroundColor: '#7BC6A4'},
  offline: {backgroundColor: '#E9B478'},
  loading: {backgroundColor: '#AEBFC4'},
  connectionText: {fontSize: 15, color: '#D9E4E4'},
  welcomeRow: {flexDirection: 'row', alignItems: 'center', gap: 36, marginTop: 26, marginBottom: 21},
  welcomeCopy: {flex: 1},
  eyebrow: {fontSize: 13, letterSpacing: 1.4, color: '#9AC8B5', fontWeight: '700'},
  heading: {fontSize: 36, lineHeight: 42, color: '#FFFDF7', fontWeight: '700', marginTop: 8},
  lede: {fontSize: 18, lineHeight: 26, color: '#D0DDDE', marginTop: 5},
  nextCard: {width: 320, minHeight: 104, backgroundColor: '#1B3B46', borderLeftWidth: 4, borderLeftColor: '#F3B86C', borderRadius: 10, paddingHorizontal: 18, paddingVertical: 13},
  nextLabel: {fontSize: 12, letterSpacing: 1.2, color: '#AFC8C9', fontWeight: '700'},
  nextTitle: {fontSize: 21, color: '#FFFDF7', fontWeight: '700', marginTop: 5},
  nextTime: {fontSize: 15, color: '#D0DDDE', marginTop: 3},
  filterSection: {marginBottom: 12},
  scrollHint: {fontSize: 14, color: '#AFC8C9', marginTop: -5, marginBottom: 7},
  navRow: {flexDirection: 'row', gap: 12, marginBottom: 16},
  navTab: {borderRadius: 10, paddingHorizontal: 18, paddingVertical: 9, borderWidth: 1, borderColor: '#668087'},
  navTabSelected: {backgroundColor: '#D4E7DE', borderColor: '#D4E7DE'},
  navText: {fontSize: 17, color: '#EDF3F0', fontWeight: '600'},
  navTextSelected: {color: '#102A35'},
  notice: {fontSize: 15, color: '#FFF0D7', marginTop: -9, marginBottom: 10},
  groupsContent: {flex: 1},
  emptyCard: {width: 520, minHeight: 180, padding: 22, borderRadius: 14, backgroundColor: '#1B3B46', justifyContent: 'space-between'},
  emptyTitle: {fontSize: 26, color: '#FFFDF7', fontWeight: '700'},
  emptyCopy: {fontSize: 18, lineHeight: 25, color: '#D0DDDE'},
  sessionCard: {width: 310, minHeight: 245, padding: 18, borderRadius: 14, backgroundColor: '#F4F1E8'},
  sessionNote: {fontSize: 15, lineHeight: 21, color: '#35515A', marginTop: 12},
  sectionTitle: {fontSize: 22, color: '#FFFDF7', fontWeight: '700', marginBottom: 9},
  filterRow: {flexDirection: 'row', gap: 11},
  filterChip: {paddingHorizontal: 18, paddingVertical: 8, borderRadius: 20, borderWidth: 1, borderColor: '#668087', backgroundColor: '#173640'},
  filterSelected: {backgroundColor: '#D4E7DE', borderColor: '#D4E7DE'},
  filterText: {fontSize: 16, color: '#EDF3F0'},
  filterTextSelected: {color: '#102A35', fontWeight: '700'},
  focused: {borderColor: '#F3B86C', borderWidth: 3, transform: [{scale: 1.03}]},
  chatPanel: {flex: 1, minHeight: 0, backgroundColor: '#173640', borderRadius: 18, padding: 18, marginTop: 2},
  chatHeader: {marginBottom: 8},
  chatHint: {fontSize: 15, color: '#C4D4D3', marginTop: -4, marginBottom: 8},
  chatClear: {alignSelf: 'flex-start', paddingHorizontal: 12, paddingVertical: 7, borderWidth: 1, borderColor: '#668087', borderRadius: 8, marginBottom: 8},
  chatClearText: {fontSize: 14, fontWeight: '700', color: '#F4F1E8'},
  chatTranscript: {flex: 1, minHeight: 150, maxHeight: 310, borderRadius: 12, backgroundColor: '#102A35'},
  chatTranscriptContent: {padding: 12, gap: 9},
  chatBubble: {maxWidth: '88%', borderRadius: 12, padding: 11},
  assistantBubble: {alignSelf: 'flex-start', backgroundColor: '#F4F1E8'},
  userBubble: {alignSelf: 'flex-end', backgroundColor: '#D4E7DE'},
  chatSpeaker: {fontSize: 11, fontWeight: '800', letterSpacing: 1, color: '#477265', marginBottom: 3},
  chatMessage: {fontSize: 16, lineHeight: 22, color: '#173640'},
  chatSuggestions: {flexDirection: 'row', gap: 10, marginTop: 11, marginBottom: 10},
  chatSuggestion: {paddingHorizontal: 14, paddingVertical: 11, backgroundColor: '#274A54', borderRadius: 10, borderWidth: 1, borderColor: '#668087'},
  chatSuggestionText: {fontSize: 15, color: '#F4F1E8', fontWeight: '700'},
  chatComposer: {flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: '#AFC8C9', backgroundColor: '#F4F1E8', borderRadius: 12, padding: 8},
  chatInput: {flex: 1, minHeight: 48, maxHeight: 86, fontSize: 18, color: '#173640', paddingHorizontal: 10},
  chatSend: {minWidth: 100, minHeight: 48, paddingHorizontal: 18, borderRadius: 9, backgroundColor: '#B7D7C9', alignItems: 'center', justifyContent: 'center'},
  chatSendText: {fontSize: 16, color: '#102A35', fontWeight: '800'},
  chatPrivacy: {fontSize: 13, lineHeight: 18, color: '#BDD0D3', marginTop: 8},
  activityRow: {gap: 16, paddingVertical: 10, paddingRight: 20},
  activityCard: {width: 280, minHeight: 250, backgroundColor: '#F4F1E8', borderRadius: 14, padding: 18},
  activityCategory: {fontSize: 12, color: '#3C7568', letterSpacing: 1.4, fontWeight: '700'},
  activityTitle: {fontSize: 22, lineHeight: 28, minHeight: 54, color: '#173640', fontWeight: '700', marginTop: 7},
  activityDescription: {fontSize: 15, lineHeight: 21, minHeight: 40, color: '#35515A'},
  recurrence: {fontSize: 15, color: '#173640', fontWeight: '700', marginTop: 8},
  accessList: {marginTop: 8, marginBottom: 12, flex: 1},
  accessText: {fontSize: 13, lineHeight: 18, color: '#35515A'},
  actionButton: {minHeight: 44, borderRadius: 8, backgroundColor: '#B7D7C9', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12},
  actionDisabled: {backgroundColor: '#C8D0CC', opacity: 0.7},
  leaveButton: {backgroundColor: '#E7D8C4'},
  actionText: {fontSize: 16, fontWeight: '700', color: '#102A35'},
  bottomBar: {height: 38, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between'},
  bottomText: {fontSize: 15, color: '#D0DDDE'},
  helpText: {fontSize: 13, color: '#AFC8C9'},
});
