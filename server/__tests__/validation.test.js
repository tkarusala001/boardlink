import { z } from 'zod';

// Mirror the schemas from index.js so we test validation logic independently
const MessageSchema = z.object({
  v:        z.number().int().optional(),
  type:     z.string(),
  roomCode: z.string().optional(),
  payload:  z.any().optional(),
});

const RoomCodeSchema = z.string().regex(/^[2-9A-Z]{4}$/);

describe('MessageSchema', () => {
  test('accepts a valid CREATE_ROOM message', () => {
    const msg = { v: 1, type: 'CREATE_ROOM' };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  test('accepts message without optional fields', () => {
    const msg = { type: 'JOIN_ROOM' };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });

  test('accepts message with roomCode and payload', () => {
    const msg = { v: 1, type: 'OFFER', roomCode: 'AB23', payload: { sdp: 'test' } };
    const result = MessageSchema.parse(msg);
    expect(result.type).toBe('OFFER');
    expect(result.roomCode).toBe('AB23');
  });

  test('rejects message missing type', () => {
    expect(() => MessageSchema.parse({ v: 1 })).toThrow();
  });

  test('rejects message with non-string type', () => {
    expect(() => MessageSchema.parse({ type: 123 })).toThrow();
  });

  test('rejects message with non-integer version', () => {
    expect(() => MessageSchema.parse({ v: 1.5, type: 'CREATE_ROOM' })).toThrow();
  });

  test('rejects completely empty object', () => {
    expect(() => MessageSchema.parse({})).toThrow();
  });
});

describe('RoomCodeSchema', () => {
  test('accepts valid 4-char uppercase code', () => {
    expect(RoomCodeSchema.parse('AB23')).toBe('AB23');
  });

  test('accepts code with all digits (no 0 or 1)', () => {
    expect(RoomCodeSchema.parse('2345')).toBe('2345');
  });

  test('rejects lowercase letters', () => {
    expect(() => RoomCodeSchema.parse('ab23')).toThrow();
  });

  test('rejects codes with 0 or 1', () => {
    expect(() => RoomCodeSchema.parse('A01B')).toThrow();
  });

  test('rejects codes shorter than 4 chars', () => {
    expect(() => RoomCodeSchema.parse('AB2')).toThrow();
  });

  test('rejects codes longer than 4 chars', () => {
    expect(() => RoomCodeSchema.parse('AB234')).toThrow();
  });

  test('rejects empty string', () => {
    expect(() => RoomCodeSchema.parse('')).toThrow();
  });
});
