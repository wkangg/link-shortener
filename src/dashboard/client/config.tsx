import { createContext, useContext } from 'react';

import type { ConfigResponse } from '../../shared/types.ts';

export const ConfigContext = createContext<ConfigResponse>({
    shortOrigin: '',
    dashOrigin: '',
    version: ''
});

export const useConfig = () => useContext(ConfigContext);
