import React, { useMemo, useState } from 'react';
import { Alert, Modal, Share } from 'react-native';
import Video from 'react-native-video';
import RNFS from 'react-native-fs';
import { useAppStore } from '../../stores/appStore';
import { resolveDocumentPath } from '../../utils/resolveDocumentPath';
import type { GeneratedVideo } from '../../types';
import { View, Text, Image, TouchableOpacity, FlatList, Platform } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { CustomAlert, hideAlert } from '../../components/CustomAlert';
import { useTheme, useThemedStyles } from '../../theme';
import { GeneratedImage } from '../../types';
import { RootStackParamList } from '../../navigation/types';
import { createStyles, COLUMN_COUNT } from './styles';
import { useGalleryActions } from './useGalleryActions';
import { GalleryGridItem } from './GridItem';
import { FullscreenViewer } from './FullscreenViewer';

type GalleryScreenRouteProp = RouteProp<RootStackParamList, 'Gallery'>;

export const GalleryScreen: React.FC = () => {
  const navigation = useNavigation();
  const route = useRoute<GalleryScreenRouteProp>();
  const conversationId = route.params?.conversationId;
  const [kind, setKind] = useState<'images' | 'videos'>('images');
  const [selectedVideo, setSelectedVideo] = useState<GeneratedVideo | null>(null);
  const videos = useAppStore(state => state.generatedVideos);
  const removeVideo = useAppStore(state => state.removeGeneratedVideo);
  const displayVideos = useMemo(() => conversationId ? videos.filter(video => video.conversationId === conversationId) : videos, [videos, conversationId]);

  const { colors } = useTheme();
  const styles = useThemedStyles(createStyles);

  const {
    isSelectMode,
    selectedIds,
    selectedImage,
    setSelectedImage,
    showDetails,
    setShowDetails,
    alertState,
    setAlertState,
    imageGenState,
    displayImages,
    handleDelete,
    toggleSelectMode,
    toggleImageSelection,
    handleDeleteSelected,
    selectAll,
    handleSaveImage,
    handleCancelGeneration,
    closeViewer,
  } = useGalleryActions(conversationId);

  const screenTitle = conversationId ? 'Chat Media' : 'Gallery';

  const renderGridItem = ({ item, index }: { item: GeneratedImage; index: number }) => (
    <GalleryGridItem
      item={item}
      index={index}
      isSelectMode={isSelectMode}
      isSelected={selectedIds.has(item.id)}
      onPress={() => {
        if (isSelectMode) {
          toggleImageSelection(item.id);
        } else {
          setSelectedImage(item);
        }
      }}
      onLongPress={() => {
        if (!isSelectMode) {
          toggleSelectMode();
          toggleImageSelection(item.id);
        }
      }}
    />
  );

  return (
    <SafeAreaView testID="gallery-screen" style={styles.container} edges={['top']}>
      <View style={styles.header}>
        {isSelectMode ? (
          <>
            <TouchableOpacity style={styles.closeButton} onPress={toggleSelectMode}>
              <Icon name="x" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.title}>{selectedIds.size} selected</Text>
            <TouchableOpacity style={styles.headerButton} onPress={selectAll}>
              <Text style={styles.headerButtonText}>All</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.headerButton, selectedIds.size === 0 && styles.headerButtonDisabled]}
              onPress={handleDeleteSelected}
              disabled={selectedIds.size === 0}
            >
              <Icon
                name="trash-2"
                size={20}
                color={selectedIds.size === 0 ? colors.textMuted : colors.error}
              />
            </TouchableOpacity>
          </>
        ) : (
          <>
            <TouchableOpacity
              accessibilityLabel="Close gallery"
              accessibilityRole="button"
              style={styles.closeButton}
              onPress={() => navigation.goBack()}
            >
              <Icon name="x" size={24} color={colors.text} />
            </TouchableOpacity>
            <Text style={styles.title}>{screenTitle}</Text>
            <Text style={styles.countBadge}>{kind === 'images' ? displayImages.length : displayVideos.length}</Text>
            {displayImages.length > 0 && (
              <TouchableOpacity style={styles.headerButton} onPress={toggleSelectMode}>
                <Icon name="check-square" size={20} color={colors.text} />
              </TouchableOpacity>
            )}
          </>
        )}
      </View>

      <View style={{ flexDirection: 'row', padding: 8, gap: 8 }}>
        {(['images', 'videos'] as const).map(tab => <TouchableOpacity key={tab} onPress={() => setKind(tab)} accessibilityRole="button"
          style={{ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 6, backgroundColor: kind === tab ? colors.primary : colors.surface }}>
          <Text style={{ color: kind === tab ? colors.background : colors.text }}>{tab === 'images' ? `Images (${displayImages.length})` : `Videos (${displayVideos.length})`}</Text>
        </TouchableOpacity>)}
      </View>

      {imageGenState.isGenerating && (
        <View style={styles.genBanner}>
          <View style={styles.genBannerRow}>
            {imageGenState.previewPath && (
              <Image
                source={{ uri: imageGenState.previewPath }}
                style={styles.genPreview}
                resizeMode="cover"
              />
            )}
            <View style={styles.genBannerInfo}>
              <Text style={styles.genBannerTitle} numberOfLines={1}>
                {imageGenState.previewPath ? 'Refining...' : 'Generating...'}
              </Text>
              <Text style={styles.genBannerPrompt} numberOfLines={1}>
                {imageGenState.prompt}
              </Text>
              {imageGenState.progress && (
                <View style={styles.genProgressBar}>
                  <View
                    style={[
                      styles.genProgressFill,
                      { width: `${(imageGenState.progress.step / imageGenState.progress.totalSteps) * 100}%` },
                    ]}
                  />
                </View>
              )}
            </View>
            {imageGenState.progress && (
              <Text style={styles.genSteps}>
                {imageGenState.progress.step}/{imageGenState.progress.totalSteps}
              </Text>
            )}
            <TouchableOpacity style={styles.genCancelButton} onPress={handleCancelGeneration}>
              <Icon name="x" size={16} color={colors.error} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {kind === 'videos' ? (displayVideos.length === 0 ? <View style={styles.emptyContainer}><Icon name="video" size={48} color={colors.textMuted} /><Text style={styles.emptyTitle}>No videos in this gallery</Text></View> :
        <FlatList data={displayVideos} keyExtractor={item => item.id} contentContainerStyle={{ padding: 12 }}
          renderItem={({ item }) => <TouchableOpacity onPress={() => setSelectedVideo(item)} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', padding: 16, marginBottom: 8, backgroundColor: colors.surface, borderRadius: 8, gap: 12 }}><Icon name="play-circle" size={28} color={colors.primary} /><View style={{ flex: 1 }}><Text numberOfLines={2} style={{ color: colors.text }}>{item.prompt}</Text><Text style={{ color: colors.textMuted }}>{item.durationSeconds.toFixed(1)} s · {item.width} × {item.height}</Text></View></TouchableOpacity>} />
      ) : displayImages.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Icon name="image" size={48} color={colors.textMuted} />
          <Text style={styles.emptyTitle}>
            {conversationId ? 'No images in this chat' : 'No generated images yet'}
          </Text>
          <Text style={styles.emptyText}>Generate images from any chat conversation.</Text>
        </View>
      ) : (
        <FlatList
          data={displayImages}
          renderItem={renderGridItem}
          keyExtractor={(item) => item.id}
          numColumns={COLUMN_COUNT}
          contentContainerStyle={styles.gridContainer}
          columnWrapperStyle={styles.gridRow}
          showsVerticalScrollIndicator={false}
          removeClippedSubviews={Platform.OS !== 'android'}
        />
      )}

      <Modal visible={!!selectedVideo} animationType="slide" onRequestClose={() => setSelectedVideo(null)}>
        <SafeAreaView style={styles.container}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', padding: 16 }}>
            <TouchableOpacity onPress={() => setSelectedVideo(null)}><Text style={{ color: colors.text }}>Close</Text></TouchableOpacity>
            {selectedVideo ? <TouchableOpacity onPress={() => {
              const source = resolveDocumentPath(selectedVideo.videoPath);
              if (Platform.OS === 'ios') {
                void Share.share({ url: `file://${source}` });
              } else {
                const destination = `${RNFS.DownloadDirectoryPath}/${selectedVideo.id}.mp4`;
                void RNFS.copyFile(source, destination)
                  .then(() => Alert.alert('Video saved', 'The video is in Downloads.'))
                  .catch(() => Alert.alert('Save failed', 'The video could not be saved.'));
              }
            }}><Text style={{ color: colors.primary }}>{Platform.OS === 'ios' ? 'Share' : 'Save'}</Text></TouchableOpacity> : null}
          </View>
          {selectedVideo ? <>
            <Video source={{ uri: `file://${resolveDocumentPath(selectedVideo.videoPath)}` }} controls paused resizeMode="contain" style={{ width: '100%', aspectRatio: selectedVideo.width / selectedVideo.height, backgroundColor: '#000' }} />
            <Text style={{ color: colors.text, padding: 16 }}>{selectedVideo.prompt}</Text>
            <TouchableOpacity onPress={() => {
              const path = resolveDocumentPath(selectedVideo.videoPath);
              removeVideo(selectedVideo.id);
              void RNFS.unlink(path).catch(() => {});
              setSelectedVideo(null);
            }} style={{ padding: 16 }}><Text style={{ color: colors.error }}>Delete video</Text></TouchableOpacity>
          </> : null}
        </SafeAreaView>
      </Modal>
      <FullscreenViewer
        image={selectedImage}
        showDetails={showDetails}
        onClose={closeViewer}
        onToggleDetails={() => setShowDetails(prev => !prev)}
        onSave={handleSaveImage}
        onDelete={handleDelete}
      />
      <CustomAlert
        visible={alertState.visible}
        title={alertState.title}
        message={alertState.message}
        buttons={alertState.buttons}
        onClose={() => setAlertState(hideAlert())}
      />
    </SafeAreaView>
  );
};
