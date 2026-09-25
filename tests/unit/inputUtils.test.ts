import { jest } from '@jest/globals';

const mockGetInput = jest.fn<(name: string, options?: unknown) => string>();
const mockWarning = jest.fn<(message: string) => void>();

jest.unstable_mockModule('@actions/core', () => ({
  getInput: mockGetInput,
  warning: mockWarning,
}));

const {
  getInputAsArray,
  getInputAsBool,
  getInputAsEnum,
  getInputAsInt,
  getInputWithEnv,
  isExactKeyMatch,
  isValidEvent,
  formatSize,
} = await import('../../src/utils/inputUtils');
const { Events } = await import('../../src/constants');

describe('Input Utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    mockGetInput.mockReturnValue('');
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getInputAsArray', () => {
    it('splits multiline inputs and trims whitespace', () => {
      mockGetInput.mockReturnValueOnce('  path/one  \n\n  path/two\npath/three  ');
      expect(getInputAsArray('path')).toEqual(['path/one', 'path/two', 'path/three']);
    });

    it('returns empty array when input is blank', () => {
      mockGetInput.mockReturnValueOnce('');
      expect(getInputAsArray('path')).toEqual([]);
    });
  });

  describe('getInputAsBool', () => {
    it.each(['true', 'True', 'TRUE'])('reads %s as true', (value) => {
      mockGetInput.mockReturnValue(value);
      expect(getInputAsBool('flag')).toBe(true);
    });

    it.each(['false', 'False', 'FALSE'])('reads %s as false', (value) => {
      mockGetInput.mockReturnValue(value);
      expect(getInputAsBool('flag', true)).toBe(false);
    });

    it('returns the default for an empty input without warning', () => {
      mockGetInput.mockReturnValue('');
      expect(getInputAsBool('flag', true)).toBe(true);
      expect(mockWarning).not.toHaveBeenCalled();
    });

    it.each(['yes', '1', 'tRuE'])('warns about %s and returns the default', (value) => {
      mockGetInput.mockReturnValue(value);
      expect(getInputAsBool('flag', true)).toBe(true);
      expect(mockWarning).toHaveBeenCalledWith(expect.stringContaining('Input "flag"'));
    });
  });

  describe('getInputAsEnum', () => {
    const colours = ['red', 'green'] as const;

    it('returns an allowed value', () => {
      mockGetInput.mockReturnValue('green');
      expect(getInputAsEnum('colour', colours, 'red')).toBe('green');
    });

    it('returns the default for an empty input without warning', () => {
      mockGetInput.mockReturnValue('');
      expect(getInputAsEnum('colour', colours, 'red')).toBe('red');
      expect(mockWarning).not.toHaveBeenCalled();
    });

    it('warns about a value that is not allowed', () => {
      mockGetInput.mockReturnValue('GREEN');
      expect(getInputAsEnum('colour', colours, 'red')).toBe('red');
      expect(mockWarning).toHaveBeenCalledWith(
        'Input "colour" must be one of red, green; got "GREEN". Using "red".'
      );
    });
  });

  describe('getInputAsInt', () => {
    it('parses valid positive integer', () => {
      mockGetInput.mockReturnValueOnce('32');
      expect(getInputAsInt('upload-chunk-size')).toBe(32);
    });

    it('returns default value for empty, invalid, or negative values', () => {
      mockGetInput.mockReturnValueOnce('');
      expect(getInputAsInt('upload-chunk-size', 16)).toBe(16);

      mockGetInput.mockReturnValueOnce('invalid');
      expect(getInputAsInt('upload-chunk-size', 16)).toBe(16);

      mockGetInput.mockReturnValueOnce('-5');
      expect(getInputAsInt('upload-chunk-size', 16)).toBe(16);
    });
  });

  describe('getInputWithEnv', () => {
    it('returns primary input if set', () => {
      mockGetInput.mockReturnValueOnce('primary-value');
      const val = getInputWithEnv('bucket', ['AWS_S3_BUCKET'], 'bucketName');
      expect(val).toBe('primary-value');
    });

    it('returns camelCase input alias if primary is empty', () => {
      mockGetInput.mockImplementation((name: string) => {
        if (name === 'accessKey') return 'camel-value';
        return '';
      });

      const val = getInputWithEnv('access-key', ['AWS_ACCESS_KEY_ID'], 'accessKey');
      expect(val).toBe('camel-value');
    });

    it('falls back to environment variable list in order', () => {
      process.env.ALT_VAR = 'alt-value';
      const val = getInputWithEnv('input', ['EMPTY_VAR', 'ALT_VAR']);
      expect(val).toBe('alt-value');
    });

    it('returns empty string if neither input nor env vars are present', () => {
      const val = getInputWithEnv('missing', ['NON_EXISTENT']);
      expect(val).toBe('');
    });
  });

  describe('isExactKeyMatch', () => {
    it('returns true for exact match ignoring case and trailing whitespace', () => {
      expect(isExactKeyMatch('Linux-node-abc', '  linux-node-abc  ')).toBe(true);
    });

    it('returns false for partial match or missing matched key', () => {
      expect(isExactKeyMatch('Linux-node-abc', 'Linux-node-')).toBe(false);
      expect(isExactKeyMatch('Linux-node-abc', undefined)).toBe(false);
    });
  });

  describe('isValidEvent', () => {
    it('returns true when GITHUB_EVENT_NAME is set', () => {
      process.env[Events.Key] = 'push';
      expect(isValidEvent()).toBe(true);
    });

    it('returns false when GITHUB_EVENT_NAME is not set', () => {
      delete process.env[Events.Key];
      expect(isValidEvent()).toBe(false);
    });
  });

  describe('formatSize', () => {
    it('handles undefined, null, NaN, and 0 bytes', () => {
      expect(formatSize(undefined)).toBe('0 B');
      expect(formatSize(NaN)).toBe('0 B');
      expect(formatSize(0)).toBe('0 B');
    });

    it('formats bytes, KB, MB, GB, TB appropriately', () => {
      expect(formatSize(512)).toBe('512.00 B');
      expect(formatSize(1024)).toBe('1.00 KB');
      expect(formatSize(1024 * 1024 * 5.5)).toBe('5.50 MB');
      expect(formatSize(1024 * 1024 * 1024 * 2.25)).toBe('2.25 GB');
      expect(formatSize(1024 * 1024 * 1024 * 1024 * 3.1)).toBe('3.10 TB');
    });
  });
});
