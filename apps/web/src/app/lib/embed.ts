// Whether the app runs inside a frame of another page. A top that cannot be read counts as a frame.
export const inFrame = (w: { readonly top: unknown; readonly self: unknown }): boolean => !(w.top !== null && w.top === w.self);
