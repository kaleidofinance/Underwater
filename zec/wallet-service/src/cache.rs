//! In-memory compact block cache for `zcash_client_backend::sync::run`.
//!
//! Adapted from the `BlockCache` example in zcash_client_backend's own docs,
//! with a real `with_blocks`: the doc example stubs it out, but the scanner
//! reads blocks through it. `sync::run` downloads a range, scans it and
//! deletes it, so the cache never holds more than one batch.

use std::sync::Mutex;

use async_trait::async_trait;
use zcash_client_backend::{
    data_api::{
        chain::{error, BlockCache, BlockSource},
        scanning::ScanRange,
    },
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Debug)]
pub struct CacheError(pub String);

impl std::fmt::Display for CacheError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CacheError {}

#[derive(Default)]
pub struct MemoryBlockCache {
    blocks: Mutex<Vec<CompactBlock>>,
}

fn height_of(block: &CompactBlock) -> BlockHeight {
    BlockHeight::from_u32(block.height as u32)
}

impl BlockSource for MemoryBlockCache {
    type Error = CacheError;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), error::Error<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), error::Error<WalletErrT, Self::Error>>,
    {
        let mut blocks: Vec<CompactBlock> = self
            .blocks
            .lock()
            .expect("block cache lock poisoned")
            .iter()
            .filter(|b| from_height.map_or(true, |h| height_of(b) >= h))
            .cloned()
            .collect();
        blocks.sort_by_key(|b| b.height);
        for block in blocks.into_iter().take(limit.unwrap_or(usize::MAX)) {
            with_block(block)?;
        }
        Ok(())
    }
}

#[async_trait]
impl BlockCache for MemoryBlockCache {
    fn get_tip_height(&self, range: Option<&ScanRange>) -> Result<Option<BlockHeight>, Self::Error> {
        let blocks = self.blocks.lock().expect("block cache lock poisoned");
        Ok(blocks
            .iter()
            .map(height_of)
            .filter(|h| range.map_or(true, |r| r.block_range().contains(h)))
            .max())
    }

    async fn read(&self, range: &ScanRange) -> Result<Vec<CompactBlock>, Self::Error> {
        let mut out: Vec<CompactBlock> = self
            .blocks
            .lock()
            .expect("block cache lock poisoned")
            .iter()
            .filter(|b| range.block_range().contains(&height_of(b)))
            .cloned()
            .collect();
        out.sort_by_key(|b| b.height);
        Ok(out)
    }

    async fn insert(&self, mut compact_blocks: Vec<CompactBlock>) -> Result<(), Self::Error> {
        self.blocks
            .lock()
            .expect("block cache lock poisoned")
            .append(&mut compact_blocks);
        Ok(())
    }

    async fn delete(&self, range: ScanRange) -> Result<(), Self::Error> {
        self.blocks
            .lock()
            .expect("block cache lock poisoned")
            .retain(|b| !range.block_range().contains(&height_of(b)));
        Ok(())
    }
}
