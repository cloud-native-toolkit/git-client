import {None, Optional, Some} from 'optional-typescript';

export default function first<T>(val: T[]): Optional<T> {
  if (!val || val.length === 0) {
    return None();
  }

  return Some(val[0]);
}
