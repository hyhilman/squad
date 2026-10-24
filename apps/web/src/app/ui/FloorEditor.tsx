// One floor: "use the default", or a slider and a number box. The value is text ("" = the default)
// so the same floorBody check (lib/floors.ts) runs before a save.
import { Box, Flex, HStack, NumberInput, Slider, Stack, Switch, Text } from "@chakra-ui/react";

export function FloorEditor({ label, help, value, onChange, fallback }: { label: string; help: string; value: string; onChange: (v: string) => void; fallback: number }) {
  const isDefault = value === "";
  const n = isDefault ? fallback : Number(value);
  return (
    <Stack gap="3">
      <Flex justify="space-between" align={{ base: "flex-start", sm: "flex-start" }} gap={{ base: "2", sm: "4" }} direction={{ base: "column", sm: "row" }}>
        <Box>
          <Text fontSize="sm" fontWeight="500">
            {label}
          </Text>
          <Text fontSize="xs" color="fg.muted">
            {help}
          </Text>
        </Box>
        <Switch.Root size="sm" checked={isDefault} onCheckedChange={(d) => onChange(d.checked ? "" : String(n))} flexShrink={0}>
          <Switch.HiddenInput />
          <Switch.Control />
          <Switch.Label fontSize="sm" color="fg.muted" whiteSpace="nowrap">
            Use the default
          </Switch.Label>
        </Switch.Root>
      </Flex>
      <HStack gap="4">
        <Slider.Root flex="1" size="sm" min={0} max={100} value={[n]} disabled={isDefault} onValueChange={(d) => onChange(String(d.value[0] ?? 0))} colorPalette="brand" aria-label={[label]}>
          <Slider.Control>
            <Slider.Track>
              <Slider.Range />
            </Slider.Track>
            <Slider.Thumbs />
          </Slider.Control>
        </Slider.Root>
        <NumberInput.Root size="sm" w="88px" min={0} max={100} value={String(n)} disabled={isDefault} onValueChange={(d) => onChange(d.value)} clampValueOnBlur>
          <NumberInput.Control />
          <NumberInput.Input aria-label={`${label} in percent`} fontVariantNumeric="tabular-nums" />
        </NumberInput.Root>
        <Text fontSize="sm" color="fg.muted" ml="-2">
          %
        </Text>
      </HStack>
    </Stack>
  );
}
