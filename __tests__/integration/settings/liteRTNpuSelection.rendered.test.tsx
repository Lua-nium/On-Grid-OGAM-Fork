import { installNativeBoundary, requireRTL } from '../../harness/nativeBoundary';
import { createDownloadedModel } from '../../utils/factories';

it('lets users request NPU from Chat and change it from Model Settings without loading a model', () => {
  installNativeBoundary();
  const React = require('react');
  const { render, fireEvent } = requireRTL();
  const { useAppStore } = require('../../../src/stores');
  const { GenerationSettingsModal } = require('../../../src/components/GenerationSettingsModal');
  const { TextGenerationSection } = require('../../../src/screens/ModelSettingsScreen/TextGenerationSection');
  const model = createDownloadedModel({ id: 'gemma-litert', engine: 'litert', filePath: '/models/gemma.litertlm' });
  useAppStore.getState().setDownloadedModels([model]);
  useAppStore.getState().setActiveModelId(model.id);
  useAppStore.getState().updateSettings({ liteRTBackend: 'gpu' });

  const chat = render(React.createElement(GenerationSettingsModal, { visible: true, onClose: () => {} }));
  fireEvent.press(chat.getByText('TEXT GENERATION'));
  fireEvent.press(chat.getByTestId('modal-text-advanced-toggle'));
  fireEvent.press(chat.getByText('NPU (Beta)'));
  expect(useAppStore.getState().settings.liteRTBackend).toBe('npu');
  expect(chat.getByText(/Falls back to GPU or CPU if unavailable/)).toBeTruthy();
  expect(useAppStore.getState().loadedTextModelId).toBeNull();
  chat.unmount();

  const settings = render(React.createElement(TextGenerationSection));
  fireEvent.press(settings.getByTestId('text-advanced-toggle'));
  expect(settings.getByText(/Falls back to GPU or CPU if unavailable/)).toBeTruthy();
  fireEvent.press(settings.getByText('GPU'));
  expect(useAppStore.getState().settings.liteRTBackend).toBe('gpu');
  expect(settings.queryByText(/Falls back to GPU or CPU if unavailable/)).toBeNull();
  expect(useAppStore.getState().loadedTextModelId).toBeNull();
  settings.unmount();
});
