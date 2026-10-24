import { createToaster, Portal, Stack, Toast, Toaster as ChakraToaster } from "@chakra-ui/react";

export const toaster = createToaster({ placement: "bottom-end", pauseOnPageIdle: true });

export const toastOk = (title: string) => toaster.create({ title, type: "success" });
export const toastError = (title: string) => toaster.create({ title, type: "error" });

export function Toaster() {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: "4" }}>
        {(t) => (
          <Toast.Root width={{ md: "sm" }}>
            <Toast.Indicator />
            <Stack gap="1" flex="1" maxWidth="100%">
              {t.title === undefined ? null : <Toast.Title>{t.title}</Toast.Title>}
              {t.description === undefined ? null : <Toast.Description>{t.description}</Toast.Description>}
            </Stack>
            <Toast.CloseTrigger />
          </Toast.Root>
        )}
      </ChakraToaster>
    </Portal>
  );
}
