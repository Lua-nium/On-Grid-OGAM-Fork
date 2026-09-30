import React, { useEffect, useState, useSyncExternalStore } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { Button, ModelCard } from '../../components';
import { CustomAlert, initialAlertState, showAlert, hideAlert } from '../../components/CustomAlert';
import { searchEmbeddingModels, RECOMMENDED_EMBEDDING_MODELS } from '../../services/huggingFaceModelBrowser';
import { ragService } from '../../services/rag';
import { ragDatabase, type EmbeddingModelSelection } from '../../services/rag/database';
import { useTheme, useThemedStyles } from '../../theme';
import { createStyles } from './styles';

type Candidate = Awaited<ReturnType<typeof searchEmbeddingModels>>[number];

export const EmbeddingModelsTab: React.FC = () => {
  const styles = useThemedStyles(createStyles);
  const { colors } = useTheme();
  const status = useSyncExternalStore(ragService.subscribeEmbeddingChange, ragService.getEmbeddingChange);
  const [active, setActive] = useState<EmbeddingModelSelection | null>(null);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [alert, setAlert] = useState(initialAlertState);

  useEffect(() => {
    let current = true;
    ragDatabase.ensureReady().then(() => {
      if (current) { setActive(ragDatabase.getEmbeddingModel()); setReady(true); }
    }).catch(e => { if (current) setError(String(e.message)); });
    return () => { current = false; };
  }, [status.busy]);

  useEffect(() => {
    const controller = new AbortController();
    setResults([]);
    setError('');
    if (!query.trim()) { setLoading(false); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      searchEmbeddingModels(query, controller.signal)
        .then(rows => { if (!controller.signal.aborted) setResults(rows); })
        .catch(e => { if (!controller.signal.aborted) setError(String(e.message)); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  const select = (candidate: Candidate | null) => setAlert(showAlert(
    'Rebuild search indexes?',
    `Use ${candidate?.name ?? 'the built-in MiniLM model'}? This rebuilds semantic search and all project knowledge indexes on this phone. Search waits until indexing ends. Tool search vectors are rebuilt when used. Keep the app open. Your documents are kept. If the change fails, the current model and indexes stay active.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Switch and rebuild', onPress: () => { ragService.installEmbeddingModel(candidate).catch(e => setError(String(e.message))); } },
    ],
  ));

  return (
    <ScrollView contentContainerStyle={styles.listContent} keyboardShouldPersistTaps="handled" testID="embedding-models-tab">
      <Text style={styles.sectionTitle}>Embedding models</Text>
      <Text style={styles.emptyText}>Search your project knowledge on this phone. The built-in model works offline.</Text>
      <ModelCard compact model={{ id: active?.id ?? 'bundled', name: active?.name ?? 'MiniLM (built-in)', author: 'Active embedding model' }} isDownloaded isActive />
      {active && <Button title="Use built-in model" disabled={status.busy || !ready} onPress={() => select(null)} />}
      <View style={styles.searchContainer}>
        <TextInput
          style={styles.searchInput} value={query} onChangeText={setQuery}
          placeholder="Search Hugging Face embeddings" placeholderTextColor={colors.textMuted}
          accessibilityLabel="Search Hugging Face embedding models" autoCapitalize="none" autoCorrect={false}
          testID="embedding-search-input"
        />
      </View>
      <Text style={styles.emptyText}>BERT GGUF text encoders. Download size is not runtime memory. Each model is checked on this phone before use.</Text>
      {!!status.message && <Text style={styles.emptyText} accessibilityLiveRegion="polite" testID="embedding-index-progress">{status.message}</Text>}
      {!!(status.error || error) && <Text style={styles.emptyText} accessibilityRole="alert">{status.error || error}</Text>}
      {status.busy && <Button title="Cancel model change" onPress={ragService.cancelEmbeddingChange} />}
      {loading && <Text style={styles.emptyText}>Searching Hugging Face...</Text>}
      {!loading && query.trim() !== '' && !error && results.length === 0 && <Text style={styles.emptyText}>No candidate files found. Try a different model name.</Text>}
      {!query.trim() && <Text style={styles.sectionTitle}>Recommended candidates</Text>}
      {(query.trim() ? results : RECOMMENDED_EMBEDDING_MODELS).map(candidate => (
        <ModelCard key={candidate.id} compact
          model={{ id: candidate.id, name: candidate.name, author: `${Math.round(candidate.size / 1024 / 1024)} MB download`, description: 'Candidate: device validation required' }}
          isActive={active?.id === candidate.id}
          disabled={status.busy || !ready || active?.id === candidate.id}
          onPress={() => select(candidate)}
          footer={<Button title="Check and use" disabled={status.busy || !ready || active?.id === candidate.id} onPress={() => select(candidate)} />}
        />
      ))}
      <CustomAlert {...alert} onClose={() => setAlert(hideAlert())} />
    </ScrollView>
  );
};
